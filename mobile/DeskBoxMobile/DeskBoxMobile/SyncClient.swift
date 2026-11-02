import Foundation
import Combine
import Network
import CryptoKit
import Security
import UIKit

final class SyncClient: NSObject, ObservableObject, URLSessionDelegate {
    @Published var credentials: Credentials? = Keychain.load()
    @Published var status = "OFFLINE"
    private var expectedFingerprint = ""
    @Published private(set) var busy = false

    func discover(port: UInt16 = 47830, completion: @escaping (DiscoveredDeskBox?) -> Void) {
        let connection = NWConnection(host: "255.255.255.255", port: NWEndpoint.Port(rawValue: port)!, using: .udp)
        let lock = NSLock(); var completed = false
        let finish: (DiscoveredDeskBox?) -> Void = { value in lock.lock(); defer { lock.unlock() }; if completed { return }; completed = true; completion(value) }
        connection.stateUpdateHandler = { state in if case .ready = state { connection.send(content: Data("DESKBOX_DISCOVER_V1".utf8), completion: .contentProcessed { _ in connection.receiveMessage { data, _, _, _ in finish(data.flatMap { try? JSONDecoder().decode(DiscoveredDeskBox.self, from: $0) }); connection.cancel() } }) } }
        connection.start(queue: .global())
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) { connection.cancel(); finish(nil) }
    }

    @MainActor func configure(uri: String) -> Bool {
        guard !busy else { return false }
        guard let value = URLComponents(string: uri.trimmingCharacters(in: .whitespacesAndNewlines)), value.scheme == "deskbox", value.host == "pair", let host = value.queryItems?.first(where: { $0.name == "host" })?.value, !host.isEmpty,
              let port = Int(value.queryItems?.first(where: { $0.name == "port" })?.value ?? ""), let code = value.queryItems?.first(where: { $0.name == "code" })?.value,
              let fp = value.queryItems?.first(where: { $0.name == "fp" })?.value,
              (1...65535).contains(port), code.count == 6, code.allSatisfy({ $0.isNumber }), fp.count == 64, fp.allSatisfy({ $0.isHexDigit }),
              URL(string: "https://\(host):\(port)/pair") != nil else { status = "配对链接无效，请从电脑重新复制完整链接"; return false }
        expectedFingerprint = fp.uppercased(); pair(host: host, port: port, code: code); return true
    }

    @MainActor private func pair(host: String, port: Int, code: String) {
        busy = true; status = "正在建立设备信任…"
        let pinnedFingerprint = expectedFingerprint
        expectedFingerprint = expectedFingerprint.uppercased(); let url = URL(string: "https://\(host):\(port)/pair")!
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.httpBody = try? JSONSerialization.data(withJSONObject: ["Code": code, "DeviceName": UIDevice.current.name, "Platform": "ios"]); request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let session = makeSession()
        session.dataTask(with: request) { data, _, error in
            session.finishTasksAndInvalidate()
            guard error == nil, let data, let response = try? JSONDecoder().decode(PairResponse.self, from: data), response.ok, !response.deviceId.isEmpty, !response.accessToken.isEmpty else { DispatchQueue.main.async { self.busy = false; self.status = "配对失败：检查配对码有效期、本地网络权限和电脑服务" }; return }
            let c = Credentials(host: host, port: port, thumbprint: pinnedFingerprint, deviceId: response.deviceId, token: response.accessToken, expiresAt: response.expiresAt)
            guard Keychain.save(c) else { DispatchQueue.main.async { self.busy = false; self.status = "无法保存安全凭证，配对未保存；已有离线数据保留" }; return }
            DispatchQueue.main.async { self.credentials = c; self.busy = false; self.status = "PAIRED" }
        }.resume()
    }

    @MainActor func sync(store: OfflineStore) {
        guard !store.loadFailed else { status = "本地数据未能读取，已暂停同步以保留原文件"; return }
        guard !busy else { return }
        if let c = credentials, c.expiresAt <= Int64(Date().timeIntervalSince1970 * 1000) { status = "设备授权已过期，请重新配对；离线内容仍保留"; return }
        guard let c = credentials else { status = "NOT PAIRED"; return }; expectedFingerprint = c.thumbprint; status = "SYNCING"
        busy = true
        Task {
            defer { busy = false }
            let outgoing = store.pending
            for record in outgoing {
                if await send(record, credentials: c) {
                    store.acknowledge(record)
                }
            }
            do { store.apply(try await pull(credentials: c)) }
            catch { status = error.localizedDescription; return }
            status = store.pending.isEmpty ? "ONLINE" : "部分数据未上传或存在冲突，已保留待重试"
        }
    }

    private func send(_ record: SyncRecord, credentials: Credentials) async -> Bool {
        var request = authenticated("/sync/push", credentials); request.httpMethod = "POST"
        var outgoing = record; outgoing.deviceId = credentials.deviceId
        request.httpBody = try? JSONEncoder().encode(outgoing)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        do {
            let session = makeSession(); defer { session.finishTasksAndInvalidate() }
            let (data, response) = try await session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200, let ack = try? JSONDecoder().decode(PushResponse.self, from: data) else { return false }
            return ack.ok && (ack.result == "Applied" || ack.result == "Duplicate" || ack.result == "Resolved")
        } catch { return false }
    }

    private struct PushResponse: Decodable {
        var ok: Bool; var result: String
        enum CodingKeys: String, CodingKey { case ok = "Ok", result = "Result" }
    }
    private func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral; configuration.timeoutIntervalForRequest = 15; configuration.timeoutIntervalForResource = 30
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }
    private func pull(credentials: Credentials) async throws -> [SyncRecord] {
        let session = makeSession(); defer { session.finishTasksAndInvalidate() }
        let (data, response) = try await session.data(for: authenticated("/sync/pull?since=0", credentials))
        guard let http = response as? HTTPURLResponse else { throw SyncFailure.protocolError }
        if http.statusCode == 401 { throw SyncFailure.unauthorized }
        guard http.statusCode == 200, let records = try? JSONDecoder().decode([SyncRecord].self, from: data) else { throw SyncFailure.protocolError }
        return records
    }
    private enum SyncFailure: LocalizedError {
        case unauthorized, protocolError
        var errorDescription: String? { switch self { case .unauthorized: return "设备授权已撤销或过期，请重新配对；未上传内容已保留"; case .protocolError: return "电脑返回异常数据，未上传内容已保留，请检查版本与网络" } }
    }
    @MainActor func disconnect() { guard !busy else { return }; Keychain.remove(); credentials = nil; status = "已清除此手机配对；离线数据保留" }
    private func authenticated(_ path: String, _ c: Credentials) -> URLRequest { var r = URLRequest(url: URL(string: "https://\(c.host):\(c.port)\(path)")!); r.setValue(c.deviceId, forHTTPHeaderField: "X-Device-Id"); r.setValue("Bearer \(c.token)", forHTTPHeaderField: "Authorization"); return r }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard let trust = challenge.protectionSpace.serverTrust, let cert = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let first = cert.first else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        let fingerprint = SHA256.hash(data: SecCertificateCopyData(first) as Data).map { String(format: "%02X", $0) }.joined()
        completionHandler(fingerprint == expectedFingerprint ? .useCredential : .cancelAuthenticationChallenge, fingerprint == expectedFingerprint ? URLCredential(trust: trust) : nil)
    }
}

enum Keychain {
    static let key = "DeskBoxMobileCredentials"
    static func remove() { SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrAccount: key] as CFDictionary) }
    static func save(_ value: Credentials) -> Bool {
        guard let data = try? JSONEncoder().encode(value) else { return false }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key]
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let result = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if result == errSecItemNotFound {
            var item = query; for (name, content) in attributes { item[name] = content }
            return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
        }
        return result == errSecSuccess
    }
    static func load() -> Credentials? { var result: AnyObject?; let query = [kSecClass: kSecClassGenericPassword, kSecAttrAccount: key, kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne] as CFDictionary; guard SecItemCopyMatching(query, &result) == errSecSuccess, let data = result as? Data else { return nil }; return try? JSONDecoder().decode(Credentials.self, from: data) }
}
