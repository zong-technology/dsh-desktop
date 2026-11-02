import Foundation

struct SyncRecord: Codable, Identifiable {
    var entityType = ""; var id = ""; var version: Int64 = 0; var baseVersion: Int64 = 0
    var updatedAt: Int64 = 0; var deviceId = ""; var deleted = false; var json = ""
    enum CodingKeys: String, CodingKey { case entityType = "EntityType", id = "Id", version = "Version", baseVersion = "BaseVersion", updatedAt = "UpdatedAt", deviceId = "DeviceId", deleted = "Deleted", json = "Json" }
}

struct MobileProject: Codable, Identifiable { var id = ""; var name = ""; var number = ""; var customer = ""; var equipment = ""; var owner = ""; var deadline = ""; var progress = 0.0; var progressApplicable: Bool? = nil; var risk = "medium"; enum CodingKeys:String,CodingKey{case id="Id",name="Name",number="Number",customer="Customer",equipment="Equipment",owner="Owner",deadline="Deadline",progress="Progress",progressApplicable="ProgressApplicable",risk="Risk"} }
struct MobileTask: Codable, Identifiable { var id = UUID().uuidString; var projectId = ""; var title = ""; var status = "open"; var priority = "normal"; var due = ""; var owner = ""; var notes = ""; var updatedAt: Int64? = nil; enum CodingKeys:String,CodingKey{case id="Id",projectId="ProjectId",title="Title",status="Status",priority="Priority",due="Due",owner="Owner",notes="Notes",updatedAt="UpdatedAt"} }
struct Incident: Codable, Identifiable { var id = UUID().uuidString; var projectId = ""; var equipment = ""; var severity = "S3"; var status = "open"; var description = ""; var cause = ""; var solution = ""; var owner = ""; var occurredAt = Int64(Date().timeIntervalSince1970 * 1000); var updatedAt = Int64(Date().timeIntervalSince1970 * 1000); var attachmentIds: [String] = []; enum CodingKeys:String,CodingKey{case id="Id",projectId="ProjectId",equipment="Equipment",severity="Severity",status="Status",description="Description",cause="Cause",solution="Solution",owner="Owner",occurredAt="OccurredAt",updatedAt="UpdatedAt",attachmentIds="AttachmentIds"} }
struct DiscoveredDeskBox: Codable, Identifiable { var id: String { thumbprint }; var service = "DeskBox"; var deviceName = ""; var tlsPort = 0; var thumbprint = ""; var protocolVersion = 1
    enum CodingKeys: String, CodingKey { case service = "Service", deviceName = "DeviceName", tlsPort = "TlsPort", thumbprint = "Thumbprint", protocolVersion = "ProtocolVersion" }
}
struct PairResponse: Codable { var ok = false; var deviceId = ""; var accessToken = ""; var expiresAt: Int64 = 0; var error = ""
    enum CodingKeys: String, CodingKey { case ok = "Ok", deviceId = "DeviceId", accessToken = "AccessToken", expiresAt = "ExpiresAt", error = "Error" }
}
struct Credentials: Codable { var host = ""; var port = 0; var thumbprint = ""; var deviceId = ""; var token = ""; var expiresAt: Int64 = 0 }
