import Foundation

@main struct BriefingCheck {
    static func main() {
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
        print("Briefing, endpoint and cloud login rules: PASS 24")
    }
}

