import Foundation

@main struct BriefingCheck {
    @MainActor static func main() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        let now = calendar.date(from: DateComponents(year: 2026, month: 11, day: 2, hour: 8, minute: 0))!
        var preferences = BriefingPreferences()
        var due = MobileTask(); due.id = "due"; due.due = "2026-11-02"
        var overdue = MobileTask(); overdue.id = "old"; overdue.due = "2026-11-01"
        var future = MobileTask(); future.id = "future"; future.due = "2026-11-03"; future.priority = "high"
        var done = due; done.id = "done"; done.status = "done"
        let undated = MobileTask()
        let tasks = [due, overdue, future, done, undated]
        func select(_ values: [MobileTask], _ prefs: BriefingPreferences) -> [MobileTask] { BriefingRules.tasks(values, preferences: prefs, on: now, calendar: calendar) }
        assert(BriefingRules.dateKey(now, calendar: calendar) == "2026-11-02")
        assert(Set(select(tasks, preferences).map(\.id)) == ["due", "old"])
        preferences.taskMode = "all"; assert(select(tasks, preferences).count == 4)
        preferences.taskMode = "high"; assert(select(tasks, preferences).map(\.id) == ["future"])
        preferences.taskMode = "selected"; preferences.selectedTaskIds = ["due", "done", "missing"]
        assert(select(tasks, preferences).map(\.id) == ["due"])
        preferences.selectedTaskIds = []; assert(select(tasks, preferences).isEmpty)
        let dates = BriefingRules.nextDates(preferences: preferences, now: now, calendar: calendar)
        assert(dates.count == 10 && dates.allSatisfy { !calendar.isDateInWeekend($0) && $0 > now })
        assert(calendar.component(.hour, from: dates[0]) == 8 && calendar.component(.minute, from: dates[0]) == 30)
        assert(!BriefingRules.shouldSpeak(preferences: preferences, now: now, spokenDay: "", calendar: calendar))
        preferences.autoSpeak = true
        assert(!BriefingRules.shouldSpeak(preferences: preferences, now: now, spokenDay: "", calendar: calendar))
        let later = now.addingTimeInterval(3600)
        assert(BriefingRules.shouldSpeak(preferences: preferences, now: later, spokenDay: "", calendar: calendar))
        assert(!BriefingRules.shouldSpeak(preferences: preferences, now: later, spokenDay: "2026-11-02", calendar: calendar))
        preferences.weekends = true; assert(BriefingRules.nextDates(preferences: preferences, now: now, calendar: calendar).count == 14)
        assert(try! JSONDecoder().decode(BriefingPreferences.self, from: JSONEncoder().encode(preferences)) == preferences)
        let local = SyncEndpoint(host: "192.168.1.2", port: 47831)
        let remote = SyncEndpoint(host: "100.64.1.2", port: 47831)
        assert(SyncEndpoint.validated(host: " https://host/path ", port: 47831) == nil)
        assert(SyncEndpoint.validated(host: "host", port: 0) == nil)
        assert(SyncEndpoint.validated(host: " desktop.tailnet.ts.net ", port: 47831)?.host == "desktop.tailnet.ts.net")
        assert(SyncEndpoint.candidates(primary: local, remote: local, lastSuccessful: "").count == 1)
        assert(SyncEndpoint.candidates(primary: local, remote: remote, lastSuccessful: "") == [local, remote])
        assert(SyncEndpoint.candidates(primary: local, remote: remote, lastSuccessful: remote.label) == [remote, local])
        var cloud = CloudCredential(baseUrl: "https://sync.example", deviceId: "phone", token: String(repeating: "a", count: 64), gateToken: "test", role: "ios", expiresAt: Int64(Date().addingTimeInterval(3600).timeIntervalSince1970 * 1000))
        func encoded(_ value: CloudCredential) -> String { String(data: try! JSONEncoder().encode(value), encoding: .utf8)! }
        assert(CloudCredential.decode(encoded(cloud))?.deviceId == "phone")
        cloud.role = "desktop"; assert(CloudCredential.decode(encoded(cloud)) == nil)
        cloud.role = "ios"; cloud.baseUrl = "http://sync.example"; assert(CloudCredential.decode(encoded(cloud)) == nil)
        cloud.baseUrl = "https://sync.example"; cloud.expiresAt = 0; assert(CloudCredential.decode(encoded(cloud)) == nil)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("deskbox-mobile-accept-" + UUID().uuidString)
        try! FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("state.json")
        let store = OfflineStore(fileURL: path)
        var incident = Incident(); incident.description = "压力联锁异常"; incident.projectId = "project"; incident.equipment = "PT-101"
        assert(store.updateIncident(incident) == nil)
        let original = store.incidents[0].updatedAt
        incident = store.incidents[0]; incident.status = "closed"
        assert(store.updateIncident(incident, expectedUpdatedAt: original) != nil)
        incident.solution = "校准反馈并复测"; incident.cause = "传感器偏移"
        assert(store.updateIncident(incident, expectedUpdatedAt: original) == nil)
        assert(store.updateIncident(incident, expectedUpdatedAt: original) != nil)
        assert(OfflineStore(fileURL: path).incidents[0].solution == incident.solution)
        let taskStore = OfflineStore(fileURL: directory.appendingPathComponent("tasks.json"))
        var mobile = MobileTask(); mobile.id = "conflict"; mobile.title = "手机编辑"
        var serverTask = mobile; serverTask.title = "电脑编辑"
        let server = SyncRecord(entityType: "task", id: mobile.id, version: 2, baseVersion: 1, updatedAt: 1, deviceId: "windows", json: String(data: try! JSONEncoder().encode(serverTask), encoding: .utf8)!)
        taskStore.updateTask(mobile); let outgoing = taskStore.pending[0]
        taskStore.apply([server]); taskStore.noteConflict(outgoing)
        assert(taskStore.tasks[0].title == "手机编辑" && taskStore.conflicts.count == 1)
        let savedConflict = taskStore.conflicts[0]
        assert(OfflineStore(fileURL: directory.appendingPathComponent("tasks.json")).conflicts.count == 1)
        var newer = server; newer.version = 3; taskStore.apply([newer])
        assert(taskStore.resolveConflict(savedConflict, keepPhone: true) != nil)
        assert(taskStore.resolveConflict(taskStore.conflicts[0], keepPhone: true) == nil)
        assert(taskStore.pending[0].baseVersion == 3 && taskStore.pending[0].version == 4 && taskStore.tasks[0].title == "手机编辑")
        taskStore.noteConflict(taskStore.pending[0]); var deleted = newer; deleted.version = 4; deleted.deleted = true; deleted.json = ""; taskStore.apply([deleted])
        assert(taskStore.resolveConflict(taskStore.conflicts[0], keepPhone: false) == nil)
        assert(taskStore.tasks.isEmpty && taskStore.pending.count == 1 && taskStore.pending[0].deleted)
        let tombstone = taskStore.pending[0]; taskStore.acknowledge(tombstone)
        assert(taskStore.pending.isEmpty && taskStore.conflicts.isEmpty)
        print("Briefing, cloud, incidents and conflict rules: PASS 37")
    }
}

