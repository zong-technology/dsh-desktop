import Foundation

struct BriefingPreferences: Codable, Equatable {
    var reminders = false
    var hour = 8
    var minute = 30
    var weekends = false
    var taskMode = "due"
    var selectedTaskIds: [String] = []
    var autoSpeak = false
    var weather = true
    var city: BriefingCity?
    var email = ""
}

struct BriefingCity: Codable, Equatable, Identifiable {
    var id: Int
    var name: String
    var latitude: Double
    var longitude: Double
    var admin1: String?
    var country: String?
    var label: String { [name, admin1, country].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ") }
}

enum BriefingRules {
    static func dateKey(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!)
    }
    static func tasks(_ tasks: [MobileTask], preferences: BriefingPreferences, on date: Date, calendar: Calendar = .current) -> [MobileTask] {
        let day = dateKey(date, calendar: calendar)
        return tasks.filter { task in
            guard task.status != "done" else { return false }
            switch preferences.taskMode {
            case "all": return true
            case "high": return task.priority == "high"
            case "selected": return preferences.selectedTaskIds.contains(task.id)
            default: return !task.due.isEmpty && task.due <= day
            }
        }.sorted { a, b in
            if (a.priority == "high") != (b.priority == "high") { return a.priority == "high" }
            if a.due != b.due { return !a.due.isEmpty && (b.due.isEmpty || a.due < b.due) }
            return a.id < b.id
        }
    }
    static func nextDates(preferences: BriefingPreferences, now: Date, calendar: Calendar = .current) -> [Date] {
        (0..<14).compactMap { offset in
            guard let day = calendar.date(byAdding: .day, value: offset, to: now),
                  let date = calendar.date(bySettingHour: preferences.hour, minute: preferences.minute, second: 0, of: day), date > now,
                  preferences.weekends || !calendar.isDateInWeekend(date) else { return nil }
            return date
        }
    }
    static func shouldSpeak(preferences: BriefingPreferences, now: Date, spokenDay: String, calendar: Calendar = .current) -> Bool {
        guard preferences.autoSpeak, spokenDay != dateKey(now, calendar: calendar), preferences.weekends || !calendar.isDateInWeekend(now) else { return false }
        let parts = calendar.dateComponents([.hour, .minute], from: now)
        return (parts.hour! * 60 + parts.minute!) >= preferences.hour * 60 + preferences.minute
    }
}

