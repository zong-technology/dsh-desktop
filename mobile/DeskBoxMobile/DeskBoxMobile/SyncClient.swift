import Foundation
import Combine
import Network
import CryptoKit
import Security
import UIKit

final class SyncClient: NSObject, ObservableObject, URLSessionDelegate {
    @Published var credentials: Credentials? = Keychain.load()
    @Published private(set) var cloudCredential: CloudCredential? = Keychain.load(account: "DeskBoxCloudCredential")
    @Published var status = "OFFLINE"
    private var expectedFingerprint = ""
    @Published private(set) var busy = false
    @Published private(set) var pairingAddress = ""
    private var fingerprintMismatch = false
    @Published var automatic = UserDefaults.standard.object(forKey: "automaticSync") as? Bool ?? true {
        didSet { UserDefaults.standard.set(automatic, forKey: "automaticSync") }
    }
    @Published private(set) var lastSyncedAt: Date?
    @Published private(set) var connected = false
    @Published private(set) var remoteEndpoint: SyncEndpoint? = UserDefaults.standard.data(forKey: "remoteSyncEndpoint").flatMap { try? JSONDecoder().decode(SyncEndpoint.self, from: $0) }
    @Published private(set) var activeEndpoint = ""
    private var retryAfter = Date.distantPast
    private var failures = 0
    private var sendTransportFailed = false
    @Published private(set) var networkEpoch = 0
    private let pathMonitor = NWPathMonitor()
    private let cloudSession = URLSession(configuration: .ephemeral, delegate: CloudRedirectBlocker(), delegateQueue: nil)
    override init() {
        super.init()
        pathMonitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            DispatchQueue.main.async { self?.retryAfter = .distantPast; self?.networkEpoch += 1 }
        }
        pathMonitor.start(queue: DispatchQueue(label: "DeskBox.NetworkMonitor"))
    }
    deinit { pathMonitor.cancel(); cloudSession.invalidateAndCancel() }
    @MainActor func automaticSync(store: OfflineStore, force: Bool = false) {
        guard automatic, credentials != nil || cloudCredential != nil, !busy, force || Date() >= retryAfter else { return }
        sync(store: store)
    }
    @MainActor func updateEndpoint(host: String, port: Int) -> Bool {
        guard !busy, var c = credentials, (1...65535).contains(port) else { return false }
        var url = URLComponents(); url.scheme = "https"; url.host = host.trimmingCharacters(in: .whitespacesAndNewlines); url.port = port
        guard let host = url.host, !host.isEmpty, url.url != nil else { status = "请填写有效主机名或IP（不带https://）"; return false }
        c.host = host; c.port = port
        guard Keychain.save(c) else { status = "连接地址保存失败"; return false }
        credentials = c; connected = false; retryAfter = .distantPast; status = "已更新地址，将验证原电脑证书后自动同步"; return true
    }
    @MainActor func updateRemoteEndpoint(host: String, port: Int) -> Bool {
        guard !busy else { return false }
        guard let endpoint = SyncEndpoint.validated(host: host, port: port), let data = try? JSONEncoder().encode(endpoint) else { status = "备用地址无效，请填写固定IPv4或主机名及有效端口"; return false }
        UserDefaults.standard.set(data, forKey: "remoteSyncEndpoint"); remoteEndpoint = endpoint
        retryAfter = .distantPast; status = "备用地址已保存，将自动切换并验证原电脑证书"; return true
    }
    @MainActor func removeRemoteEndpoint() {
        guard !busy else { return }
        UserDefaults.standard.removeObject(forKey: "remoteSyncEndpoint"); remoteEndpoint = nil
    }
    @MainActor func importCloud(_ text: String) -> Bool {
        guard !busy else { return false }
        guard let value = CloudCredential.decode(text) else { status = "云凭证无效、已过期或并非iPhone凭证"; return false }
        guard Keychain.save(value, account: "DeskBoxCloudCredential") else { status = "无法安全保存云凭证，旧配置保留"; return false }
        UserDefaults.standard.set(value.baseUrl, forKey: "cloudServiceURL")
        cloudCredential = value; connected = false; retryAfter = .distantPast; status = "云账号已连接，将自动同步"; return true
    }
    @MainActor func logoutCloud() {
        guard !busy else { return }
        Keychain.remove(account: "DeskBoxCloudCredential"); cloudCredential = nil; connected = false; activeEndpoint = ""; retryAfter = .distantPast
        status = "已退出云同步，离线资料与原局域网配对保留"
    }
    @MainActor private func syncCloud(store: OfflineStore) {
        guard let credential = cloudCredential else { return }
        busy = true; status = "正在同步云账号…"
        Task {
            defer { busy = false }
            do {
                for record in store.pending {
                    var outgoing = record; outgoing.deviceId = credential.deviceId
                    var request = cloudRequest("push", credential); request.httpMethod = "POST"
                    request.httpBody = try JSONEncoder().encode(outgoing)
                    let (data, response) = try await cloudSession.data(for: request)
                    try checkCloudResponse(response)
                    let result = try JSONDecoder().decode(PushResponse.self, from: data)
                    if result.ok && ["Applied", "Duplicate", "Resolved"].contains(result.result) { store.acknowledge(record) }
                }
                let (data, response) = try await cloudSession.data(for: cloudRequest("pull", credential))
                try checkCloudResponse(response)
                store.apply(try JSONDecoder().decode([SyncRecord].self, from: data))
                connected = true; failures = 0; retryAfter = Date().addingTimeInterval(15); lastSyncedAt = Date(); activeEndpoint = "云账号 · " + (URL(string: credential.baseUrl)?.host ?? "")
                status = store.pending.isEmpty ? "CLOUD ONLINE" : "云已连接 · \(store.pending.count)条等待电脑确认或冲突处理"
            } catch {
                connected = false; failures += 1; retryAfter = Date().addingTimeInterval(min(120, 5 * pow(2, Double(min(failures, 5)))))
                status = "云同步未完成，内容保留并自动重试 · " + error.localizedDescription
            }
        }
    }
    private func cloudRequest(_ action: String, _ credential: CloudCredential) -> URLRequest {
        var request = URLRequest(url: URL(string: credential.baseUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/api/cloud/" + action)!, timeoutInterval: 20)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer " + credential.token, forHTTPHeaderField: "Authorization")
        request.setValue(credential.deviceId, forHTTPHeaderField: "X-Device-Id")
        request.setValue("Bearer " + credential.gateToken, forHTTPHeaderField: "OAI-Sites-Authorization")
        return request
    }
    private func checkCloudResponse(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw SyncFailure.protocolError }
        if http.statusCode == 401 || http.statusCode == 403 || (300..<400).contains(http.statusCode) { throw SyncFailure.cloudUnauthorized }
        guard http.statusCode == 200 else { throw SyncFailure.protocolError }
    }

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
        expectedFingerprint = fp.uppercased(); fingerprintMismatch = false; pairingAddress = "\(host):\(port)"; pair(host: host, port: port, code: code); return true
    }

    @MainActor private func pair(host: String, port: Int, code: String) {
        busy = true; status = "正在建立设备信任…"
        let pinnedFingerprint = expectedFingerprint
        expectedFingerprint = expectedFingerprint.uppercased(); let url = URL(string: "https://\(host):\(port)/pair")!
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.httpBody = try? JSONSerialization.data(withJSONObject: ["Code": code, "DeviceName": UIDevice.current.name, "Platform": "ios"]); request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let session = makeSession()
        session.dataTask(with: request) { data, response, error in
            session.finishTasksAndInvalidate()
            guard error == nil, (response as? HTTPURLResponse)?.statusCode == 200, let data, let paired = try? JSONDecoder().decode(PairResponse.self, from: data), paired.ok, !paired.deviceId.isEmpty, !paired.accessToken.isEmpty else {
                let message = self.pairingFailure(error: error, response: response)
                DispatchQueue.main.async { self.busy = false; self.status = message }; return
            }
            let c = Credentials(host: host, port: port, thumbprint: pinnedFingerprint, deviceId: paired.deviceId, token: paired.accessToken, expiresAt: paired.expiresAt)
            guard Keychain.save(c) else { DispatchQueue.main.async { self.busy = false; self.status = "无法保存安全凭证，配对未保存；已有离线数据保留" }; return }
            DispatchQueue.main.async { self.credentials = c; self.busy = false; self.status = "PAIRED" }
        }.resume()
    }

    @MainActor func sync(store: OfflineStore) {
        guard !store.loadFailed else { status = "本地数据未能读取，已暂停同步以保留原文件"; return }
        guard !busy else { return }
        if cloudCredential != nil { syncCloud(store: store); return }
        guard let c = credentials else { status = "NOT PAIRED"; return }; expectedFingerprint = c.thumbprint; status = "SYNCING"
        busy = true
        Task {
            defer { busy = false }
            let candidates = SyncEndpoint.candidates(primary: SyncEndpoint(host: c.host, port: c.port), remote: remoteEndpoint, lastSuccessful: UserDefaults.standard.string(forKey: "lastSuccessfulSyncEndpoint") ?? "")
            var selected: Credentials?
            var lastError: Error = SyncFailure.protocolError
            for endpoint in candidates {
                var candidate = c; candidate.host = endpoint.host; candidate.port = endpoint.port
                status = "正在连接 " + endpoint.label
                do {
                    // Authenticate this route before uploading; pending edits survive the probe pull.
                    store.apply(try await pull(credentials: candidate))
                    for record in store.pending {
                        if await send(record, credentials: candidate) { store.acknowledge(record) }
                        if sendTransportFailed { throw SyncFailure.protocolError }
                    }
                    store.apply(try await pull(credentials: candidate))
                    selected = candidate; activeEndpoint = endpoint.label
                    UserDefaults.standard.set(endpoint.label, forKey: "lastSuccessfulSyncEndpoint"); break
                } catch {
                    lastError = error
                    if let failure = error as? SyncFailure, case .unauthorized = failure { break }
                }
            }
            guard let selected else { connected = false; failures += 1; retryAfter = Date().addingTimeInterval(min(120, 5 * pow(2, Double(min(failures, 5))))); status = "所有地址暂未连接，自动重试 · " + lastError.localizedDescription; return }
            connected = true; failures = 0; retryAfter = Date().addingTimeInterval(15); lastSyncedAt = Date()
            if c.expiresAt < Int64(Date().addingTimeInterval(7 * 86400).timeIntervalSince1970 * 1000), var request = authenticated("/device/renew", selected) {
                request.httpMethod = "POST"
                let session = makeSession(); defer { session.finishTasksAndInvalidate() }
                if let (data, response) = try? await session.data(for: request), (response as? HTTPURLResponse)?.statusCode == 200,
                   let value = try? JSONDecoder().decode(TrustExpiry.self, from: data), value.expiresAt > c.expiresAt {
                    var renewed = c; renewed.expiresAt = value.expiresAt; if Keychain.save(renewed) { credentials = renewed }
                }
            }
            status = store.pending.isEmpty ? "ONLINE" : "部分数据未上传或存在冲突，已保留待重试"
        }
    }

    @MainActor private func send(_ record: SyncRecord, credentials: Credentials) async -> Bool {
        sendTransportFailed = false
        guard var request = authenticated("/sync/push", credentials) else { return false }; request.httpMethod = "POST"
        var outgoing = record; outgoing.deviceId = credentials.deviceId
        request.httpBody = try? JSONEncoder().encode(outgoing)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        do {
            let session = makeSession(); defer { session.finishTasksAndInvalidate() }
            let (data, response) = try await session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200, let ack = try? JSONDecoder().decode(PushResponse.self, from: data) else { sendTransportFailed = true; return false }
            return ack.ok && (ack.result == "Applied" || ack.result == "Duplicate" || ack.result == "Resolved")
        } catch { sendTransportFailed = true; return false }
    }

    private struct PushResponse: Decodable {
        var ok: Bool; var result: String
        enum CodingKeys: String, CodingKey { case ok = "Ok", result = "Result" }
    }
    private struct TrustExpiry: Decodable { var expiresAt: Int64; enum CodingKeys: String, CodingKey { case expiresAt = "ExpiresAt" } }
    private func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral; configuration.timeoutIntervalForRequest = 15; configuration.timeoutIntervalForResource = 30
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }
    private func pairingFailure(error: Error?, response: URLResponse?) -> String {
        if fingerprintMismatch { return "证书指纹不匹配：请在电脑重新生成完整链接，不能手改指纹。" }
        if let code = (response as? HTTPURLResponse)?.statusCode {
            if code == 401 { return "电脑已响应，但配对码无效、已使用或过期。请重新生成，5分钟内配对。" }
            return "电脑已响应 HTTP \(code)，配对数据无法识别，请确认两端版本一致。"
        }
        guard let error else { return "未收到电脑响应，请检查所选IP和服务状态。" }
        let code = (error as NSError).code
        switch code {
        case NSURLErrorTimedOut: return "连接 \(pairingAddress) 超时（\(code)）：确认IP不是VMware/VPN网卡，检查防火墙和Wi-Fi客户端隔离。"
        case NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost: return "无法连接 \(pairingAddress)（\(code)）：电脑需启动Local Sync，手机应能访问同一局域网IP。"
        case NSURLErrorNotConnectedToInternet: return "本地网络不可用（\(code)）：请在iOS设置中允许DeskBox访问本地网络，并检查Wi-Fi。"
        case NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateUntrusted, NSURLErrorServerCertificateHasBadDate: return "TLS连接失败（\(code)）：确认电脑/手机时间正确，并从电脑重新复制链接。"
        default: return "配对连接失败（\(code)）：" + error.localizedDescription
        }
    }
    private func pull(credentials: Credentials) async throws -> [SyncRecord] {
        let session = makeSession(); defer { session.finishTasksAndInvalidate() }
        guard let request = authenticated("/sync/pull?since=0", credentials) else { throw SyncFailure.protocolError }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw SyncFailure.protocolError }
        if http.statusCode == 401 { throw SyncFailure.unauthorized }
        guard http.statusCode == 200, let records = try? JSONDecoder().decode([SyncRecord].self, from: data) else { throw SyncFailure.protocolError }
        return records
    }
    private enum SyncFailure: LocalizedError {
        case unauthorized, protocolError, cloudUnauthorized
        var errorDescription: String? { switch self { case .unauthorized: return "设备授权已撤销或过期，请重新配对；未上传内容已保留"; case .protocolError: return "服务返回异常数据，未上传内容已保留，请检查版本与网络"; case .cloudUnauthorized: return "云设备授权已撤销或过期，请登录网页重新授权此手机" } }
    }
    @MainActor func disconnect() { guard !busy else { return }; Keychain.remove(); credentials = nil; connected = false; activeEndpoint = ""; removeRemoteEndpoint(); UserDefaults.standard.removeObject(forKey: "lastSuccessfulSyncEndpoint"); status = "已清除此手机配对；离线数据保留" }
    private func authenticated(_ path: String, _ c: Credentials) -> URLRequest? {
        var components = URLComponents(); components.scheme = "https"; components.host = c.host; components.port = c.port
        let parts = path.split(separator: "?", maxSplits: 1); components.path = String(parts[0]); if parts.count > 1 { components.percentEncodedQuery = String(parts[1]) }
        guard let url = components.url else { return nil }; var request = URLRequest(url: url); request.setValue(c.deviceId, forHTTPHeaderField: "X-Device-Id"); request.setValue("Bearer \(c.token)", forHTTPHeaderField: "Authorization"); return request
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard let trust = challenge.protectionSpace.serverTrust, let cert = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let first = cert.first else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        let fingerprint = SHA256.hash(data: SecCertificateCopyData(first) as Data).map { String(format: "%02X", $0) }.joined()
        if fingerprint != expectedFingerprint { fingerprintMismatch = true }
        completionHandler(fingerprint == expectedFingerprint ? .useCredential : .cancelAuthenticationChallenge, fingerprint == expectedFingerprint ? URLCredential(trust: trust) : nil)
    }
}

private final class CloudRedirectBlocker: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

enum Keychain {
    static let key = "DeskBoxMobileCredentials"
    static func remove(account: String = key) { SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrAccount: account] as CFDictionary) }
    static func save<T: Encodable>(_ value: T, account: String = key) -> Bool {
        guard let data = try? JSONEncoder().encode(value) else { return false }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: account]
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let result = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if result == errSecItemNotFound {
            var item = query; for (name, content) in attributes { item[name] = content }
            return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
        }
        return result == errSecSuccess
    }
    static func load<T: Decodable>(account: String = key) -> T? { var result: AnyObject?; let query = [kSecClass: kSecClassGenericPassword, kSecAttrAccount: account, kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne] as CFDictionary; guard SecItemCopyMatching(query, &result) == errSecSuccess, let data = result as? Data else { return nil }; return try? JSONDecoder().decode(T.self, from: data) }
}

