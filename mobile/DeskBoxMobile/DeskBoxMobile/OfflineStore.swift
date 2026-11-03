import Foundation
import Combine

@MainActor final class OfflineStore: ObservableObject {
    @Published var projects: [MobileProject] = []
    @Published var tasks: [MobileTask] = []
    @Published var incidents: [Incident] = []
    @Published var pending: [SyncRecord] = []
    @Published private(set) var conflicts: [MobileConflict] = []
    @Published var storageError = ""
    @Published private(set) var loadFailed = false
    private var versions: [String: Int64] = [:]
    private let url: URL
    private var remoteRecords: [String: SyncRecord] = [:]

    init(fileURL: URL? = nil) { url = fileURL ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("deskbox-mobile.json"); load() }
    func save() {
        guard !loadFailed else { return }
        do { try JSONEncoder().encode(Snapshot(projects: projects, tasks: tasks, incidents: incidents, pending: pending, versions: versions, conflicts: conflicts)).write(to: url, options: .atomic); storageError = "" }
        catch { storageError = "本地保存失败，尚未确认持久化：" + error.localizedDescription }
    }
    func load() {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        do {
            let value = try JSONDecoder().decode(Snapshot.self, from: Data(contentsOf: url))
            projects = value.projects; tasks = value.tasks; incidents = value.incidents; pending = value.pending; versions = value.versions ?? [:]; loadFailed = false; storageError = ""
            conflicts = value.conflicts ?? []; remoteRecords = [:]
            for conflict in conflicts { if let remote = conflict.remote { remoteRecords[conflict.id] = remote } }
        } catch { loadFailed = true; storageError = "本地数据读取失败，原文件已保留，暂停写入与同步：" + error.localizedDescription }
    }
    func queue<T: Encodable>(_ type: String, id: String, value: T) {
        guard !loadFailed else { return }
        guard let data = try? JSONEncoder().encode(value), let json = String(data: data, encoding: .utf8) else { return }
        let previous = pending.first { $0.entityType == type && $0.id == id }
        let base = previous?.baseVersion ?? versions[type + ":" + id] ?? 0
        let timestamp = max(Int64(Date().timeIntervalSince1970 * 1000), (previous?.updatedAt ?? 0) + 1)
        pending.removeAll { $0.entityType == type && $0.id == id }
        pending.append(SyncRecord(entityType: type, id: id, version: base + 1, baseVersion: base, updatedAt: timestamp, deviceId: "", deleted: false, json: json))
        conflicts.removeAll { $0.id == type + ":" + id }; save()
    }
    func apply(_ records: [SyncRecord]) {
        for record in records {
            let key = record.entityType + ":" + record.id
            if record.version >= (remoteRecords[key]?.version ?? 0) { remoteRecords[key] = record }
            // Unacknowledged local edits survive a pull, including remote tombstones.
            if pending.contains(where: { $0.entityType == record.entityType && $0.id == record.id }) {
                if let index = conflicts.firstIndex(where: { $0.id == key }) { conflicts[index].remote = remoteRecords[key] }
                continue
            }
            conflicts.removeAll { $0.id == key }
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
        conflicts.removeAll { $0.id == record.entityType + ":" + record.id && $0.local.updatedAt <= record.updatedAt }
        versions[record.entityType + ":" + record.id] = record.version
        if let index = pending.firstIndex(where: { $0.entityType == record.entityType && $0.id == record.id }) {
            if pending[index].updatedAt == record.updatedAt && pending[index].json == record.json { pending.remove(at: index) }
            else { pending[index].baseVersion = record.version; pending[index].version = record.version + 1 }
        }
        save()
    }
    func noteConflict(_ record: SyncRecord) {
        guard !loadFailed, pending.contains(where: { $0.entityType == record.entityType && $0.id == record.id && $0.updatedAt == record.updatedAt && $0.json == record.json && $0.deleted == record.deleted }) else { return }
        let key = record.entityType + ":" + record.id
        conflicts.removeAll { $0.id == key }; conflicts.append(MobileConflict(local: record, remote: remoteRecords[key])); save()
    }
    func resolveConflict(_ conflict: MobileConflict, keepPhone: Bool) -> String? {
        guard !loadFailed else { return storageError }
        guard let live = conflicts.first(where: { $0.id == conflict.id }), live.local.updatedAt == conflict.local.updatedAt, let remote = live.remote,
              remote.version == conflict.remote?.version, remote.version >= (versions[conflict.id] ?? 0), remote.canResolveOnPhone, let index = pending.firstIndex(where: { $0.entityType == conflict.local.entityType && $0.id == conflict.local.id }), pending[index].updatedAt == conflict.local.updatedAt else { return "版本已变化或远端记录无效，请刷新冲突列表再选择，当前内容已保留" }
        if keepPhone {
            pending[index].baseVersion = remote.version; pending[index].version = remote.version + 1
            pending[index].updatedAt = max(Int64(Date().timeIntervalSince1970 * 1000), pending[index].updatedAt + 1)
        } else { pending.remove(at: index) }
        conflicts.removeAll { $0.id == conflict.id }
        if !keepPhone {
            apply([remote])
            // Submit the chosen computer content too, so its old conflict is closed by the same version check.
            var choice = remote; choice.baseVersion = remote.version; choice.version = remote.version + 1
            choice.updatedAt = max(Int64(Date().timeIntervalSince1970 * 1000), conflict.local.updatedAt + 1); choice.deviceId = ""
            pending.append(choice)
        }
        save()
        return storageError.isEmpty ? nil : storageError
    }
    func updateTask(_ task: MobileTask) {
        guard !loadFailed else { return }
        var value = task; value.updatedAt = Int64(Date().timeIntervalSince1970 * 1000)
        tasks.removeAll { $0.id == value.id }; tasks.append(value)
        queue("task", id: value.id, value: value)
    }
    func updateIncident(_ incident: Incident, expectedUpdatedAt: Int64? = nil) -> String? {
        guard !loadFailed else { return storageError }
        if let error = incident.validationError { return error }
        if let expectedUpdatedAt, incidents.first(where: { $0.id == incident.id })?.updatedAt != expectedUpdatedAt { return "事件已被更新，请关闭编辑页后重新打开；当前内容尚未提交" }
        var value = incident; value.updatedAt = max(Int64(Date().timeIntervalSince1970 * 1000), value.updatedAt + 1)
        incidents.removeAll { $0.id == value.id }; incidents.append(value)
        queue("incident", id: value.id, value: value)
        return storageError.isEmpty ? nil : storageError
    }
    func deleteTask(_ id: String) {
        guard !loadFailed else { return }
        let old = pending.first { $0.entityType == "task" && $0.id == id }
        let base = old?.baseVersion ?? versions["task:" + id] ?? 0
        tasks.removeAll { $0.id == id }; pending.removeAll { $0.entityType == "task" && $0.id == id }
        conflicts.removeAll { $0.id == "task:" + id }
        pending.append(SyncRecord(entityType: "task", id: id, version: base + 1, baseVersion: base, updatedAt: max(Int64(Date().timeIntervalSince1970 * 1000), (old?.updatedAt ?? 0) + 1), deviceId: "", deleted: true, json: "")); save()
    }
    private struct Snapshot: Codable { var projects: [MobileProject]; var tasks: [MobileTask]; var incidents: [Incident]; var pending: [SyncRecord]; var versions: [String: Int64]?; var conflicts: [MobileConflict]? }
}

