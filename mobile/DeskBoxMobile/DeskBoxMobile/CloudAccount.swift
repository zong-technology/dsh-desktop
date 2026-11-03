import Foundation

struct CloudCredential: Codable {
    var baseUrl: String
    var deviceId: String
    var token: String
    var gateToken: String
    var role: String
    var expiresAt: Int64
    enum CodingKeys: String, CodingKey { case baseUrl = "BaseUrl", deviceId = "DeviceId", token = "Token", gateToken = "GateToken", role = "Role", expiresAt = "ExpiresAt" }
    static func loginURL(_ value: String) -> URL? {
        guard let url = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)), url.scheme == "https", url.host?.isEmpty == false, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/" else { return nil }
        return url.url
    }
    static func decode(_ text: String) -> CloudCredential? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        var data = Data(trimmed.utf8)
        if let url = URLComponents(string: trimmed), url.scheme == "deskbox", url.host == "cloud" {
            guard let encoded = url.queryItems?.first(where: { $0.name == "data" })?.value, let decoded = Data(base64Encoded: encoded) else { return nil }
            data = decoded
        }
        guard let value = try? JSONDecoder().decode(CloudCredential.self, from: data),
              let url = URLComponents(string: value.baseUrl), url.scheme == "https", url.host?.isEmpty == false,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/",
              value.role == "ios", !value.deviceId.isEmpty, value.token.count == 64, value.token.allSatisfy(\.isHexDigit), !value.gateToken.isEmpty,
              value.expiresAt > Int64(Date().timeIntervalSince1970 * 1000) else { return nil }
        return value
    }
}

