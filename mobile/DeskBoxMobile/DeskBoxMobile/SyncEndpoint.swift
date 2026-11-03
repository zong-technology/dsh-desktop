import Foundation

struct SyncEndpoint: Codable, Equatable {
    var host: String
    var port: Int
    var label: String { host + ":" + String(port) }
    static func validated(host: String, port: Int) -> SyncEndpoint? {
        let host = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty, (1...65535).contains(port), !host.contains(where: { $0.isWhitespace || "/?#@:".contains($0) }) else { return nil }
        var components = URLComponents(); components.scheme = "https"; components.host = host; components.port = port
        guard components.url != nil else { return nil }
        return SyncEndpoint(host: host, port: port)
    }
    static func candidates(primary: SyncEndpoint, remote: SyncEndpoint?, lastSuccessful: String) -> [SyncEndpoint] {
        guard let remote, remote != primary else { return [primary] }
        return remote.label == lastSuccessful ? [remote, primary] : [primary, remote]
    }
}

