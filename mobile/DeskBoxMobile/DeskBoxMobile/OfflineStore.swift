import Foundation
import Combine

@MainActor final class OfflineStore: ObservableObject {
    @Published var projects: [MobileProject] = []
    @Published var tasks: [MobileTask] = []
    @Published var incidents: [Incident] = []
    @Published var pending: [SyncRecord] = []
    @Published var storageError = ""
    @Published private(set) var loadFailed = false
    private var versions: [String: Int64] = [:]
    private let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("deskbox-mobile.json")

    init() { load() }
    func save() {
        guard !loadFailed else { return }
        do { try JSONEncoder().encode(Snapshot(projects: projects, tasks: tasks, incidents: incidents, pending: pending, versions: versions)).write(to: url, options: .atomic); storageError = "" }
        catch { storageError = "本地保存失败，尚未确认持久化：" + error.localizedDescription }
    }
    func load() {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        do {
            let value = try JSONDecoder().decode(Snapshot.self, from: Data(contentsOf: url))
            projects = value.projects; tasks = value.tasks; incidents = value.incidents; pending = value.pending; versions = value.versions ?? [:]; loadFailed = false; storageError = ""
        } catch { loadFailed = true; storageError = "本地数据读取失败，原文件已保留，暂停写入与同步：" + error.localizedDescription }
    }
    func queue<T: Encodable>(_ type: String, id: String, value: T) {
        guard !loadFailed else { return }
        guard let data = try? JSONEncoder().encode(value), let json = String(data: data, encoding: .utf8) else { return }
        let previous = pending.first { $0.entityType == type && $0.id == id }
        let base = previous?.baseVersion ?? versions[type + ":" + id] ?? 0
        let timestamp = max(Int64(Date().timeIntervalSince1970 * 1000), (previous?.updatedAt ?? 0) + 1)
        pending.removeAll { $0.entityType == type && $0.id == id }
        pending.append(SyncRecord(entityType: type, id: id, version: base + 1, baseVersion: base, updatedAt: timestamp, deviceId: "", deleted: false, json: json)); save()
    }
    func apply(_ records: [SyncRecord]) {
        for record in records {
            // Unacknowledged local edits survive a pull, including remote tombstones.
            if pending.contains(where: { $0.entityType == record.entityType && $0.id == record.id }) { continue }
            let key = record.entityType + ":" + record.id
            if record.version < (versions[key] ?? 0) { continue }
            if record.deleted {
                if record.entityType == "project" { projects.removeAll { $0.id == record.id } }
                if record.entityType == "task" { tasks.removeAll { $0.id == record.id } }
                if record.entityType == "incident" { incidents.removeAll { $0.id == record.id } }
                versions[key] = record.version; continue
            }
            guard let data = record.json.data(using: .utf8) else { continue }
            if record.entityType == "project", let x = try? JSONDecoder().decode(MobileProject.self, from: data), x.id == record.id { projects.removeAll { $0.id == x.id }; projects.append(x); versions[key] = record.version }
            if record.entityType == "task", let x = try? JSONDecoder().decode(MobileTask.self, from: data), x.id == record.id { tasks.removeAll { $0.id == x.id }; tasks.append(x); versions[key] = record.version }
            if record.entityType == "incident", let x = try? JSONDecoder().decode(Incident.self, from: data), x.id == record.id { incidents.removeAll { $0.id == x.id }; incidents.append(x); versions[key] = record.version }
        }
        save()
    }
    func acknowledge(_ record: SyncRecord) {
        versions[record.entityType + ":" + record.id] = record.version
        if let index = pending.firstIndex(where: { $0.entityType == record.entityType && $0.id == record.id }) {
            if pending[index].updatedAt == record.updatedAt && pending[index].json == record.json { pending.remove(at: index) }
            else { pending[index].baseVersion = record.version; pending[index].version = record.version + 1 }
        }
        save()
    }
    func updateTask(_ task: MobileTask) {
        guard !loadFailed else { return }
        var value = task; value.updatedAt = Int64(Date().timeIntervalSince1970 * 1000)
        tasks.removeAll { $0.id == value.id }; tasks.append(value)
        queue("task", id: value.id, value: value)
    }
    func deleteTask(_ id: String) {
        guard !loadFailed else { return }
        let old = pending.first { $0.entityType == "task" && $0.id == id }
        let base = old?.baseVersion ?? versions["task:" + id] ?? 0
        tasks.removeAll { $0.id == id }; pending.removeAll { $0.entityType == "task" && $0.id == id }
        pending.append(SyncRecord(entityType: "task", id: id, version: base + 1, baseVersion: base, updatedAt: Int64(Date().timeIntervalSince1970 * 1000), deviceId: "", deleted: true, json: "")); save()
    }
    private struct Snapshot: Codable { var projects: [MobileProject]; var tasks: [MobileTask]; var incidents: [Incident]; var pending: [SyncRecord]; var versions: [String: Int64]? }
}
