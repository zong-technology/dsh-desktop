import SwiftUI
import Combine
import UserNotifications
import AVFoundation
import MessageUI

struct BriefingForecast: Codable {
    var city: BriefingCity
    var fetchedAt: Date
    var daily: Days
    struct Days: Codable {
        var time: [String]
        var weather_code: [Int]
        var temperature_2m_max: [Double]
        var temperature_2m_min: [Double]
        var precipitation_probability_max: [Int?]
    }
    func text(on date: Date) -> String? {
        guard let index = daily.time.firstIndex(of: BriefingRules.dateKey(date)),
              index < daily.weather_code.count, index < daily.temperature_2m_max.count,
              index < daily.temperature_2m_min.count else { return nil }
        let code = daily.weather_code[index]
        let condition: String
        switch code {
        case 0: condition = "晴"
        case 1...3: condition = "多云"
        case 45, 48: condition = "雾"
        case 51...67, 80...82: condition = "有雨"
        case 71...77, 85, 86: condition = "有雪"
        case 95...99: condition = "雷雨"
        default: condition = "天气变化"
        }
        var value = "\(city.name)，\(condition)，\(Int(daily.temperature_2m_min[index].rounded()))至\(Int(daily.temperature_2m_max[index].rounded()))摄氏度"
        if index < daily.precipitation_probability_max.count, let rain = daily.precipitation_probability_max[index], rain >= 50 { value += "，降水概率\(rain)%，外出带伞" }
        return value
    }
}

@MainActor final class DailyBriefing: NSObject, ObservableObject, UNUserNotificationCenterDelegate, AVSpeechSynthesizerDelegate {
    @Published var preferences: BriefingPreferences {
        didSet { if let data = try? JSONEncoder().encode(preferences) { UserDefaults.standard.set(data, forKey: "dailyBriefingPreferences") } }
    }
    @Published private(set) var forecast: BriefingForecast?
    @Published private(set) var weatherStatus = "选择城市后获取天气"
    @Published private(set) var notificationStatus = "尚未启用每日提醒"
    @Published private(set) var weatherBusy = false
    private let speaker = AVSpeechSynthesizer()
    private var weatherRetryAfter = Date.distantPast
    private var scheduleTask: Task<Void, Never>?
    private var scheduledSignature = ""

    override init() {
        let defaults = UserDefaults.standard
        preferences = defaults.data(forKey: "dailyBriefingPreferences").flatMap { try? JSONDecoder().decode(BriefingPreferences.self, from: $0) } ?? BriefingPreferences()
        forecast = defaults.data(forKey: "dailyBriefingForecast").flatMap { try? JSONDecoder().decode(BriefingForecast.self, from: $0) }
        super.init()
        speaker.delegate = self
        UNUserNotificationCenter.current().delegate = self
    }

    func summary(tasks: [MobileTask], on date: Date = Date()) -> String {
        let selected = BriefingRules.tasks(tasks, preferences: preferences, on: date)
        var lines = ["工程日报 · " + BriefingRules.dateKey(date)]
        if preferences.weather {
            if let forecast, forecast.city == preferences.city, let text = forecast.text(on: date) {
                lines.append((Date().timeIntervalSince(forecast.fetchedAt) > 6 * 3600 ? "缓存预报：" : "天气预报：") + text)
            } else { lines.append("天气预报暂不可用") }
        }
        lines.append(selected.isEmpty ? "所选范围没有待办任务。" : "所选范围有\(selected.count)项待办。")
        for task in selected.prefix(20) { lines.append("• " + task.title + (task.due.isEmpty ? "" : "，截止" + task.due)) }
        if selected.count > 20 { lines.append("其余\(selected.count - 20)项请打开任务页查看。") }
        return lines.joined(separator: "\n")
    }

    func speak(tasks: [MobileTask]) {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: .duckOthers)
            try AVAudioSession.sharedInstance().setActive(true)
            speaker.stopSpeaking(at: .immediate)
            let utterance = AVSpeechUtterance(string: summary(tasks: tasks))
            utterance.voice = AVSpeechSynthesisVoice(language: "zh-CN")
            speaker.speak(utterance)
        } catch { weatherStatus = "语音播放失败：" + error.localizedDescription }
    }
    func stopSpeaking() { speaker.stopSpeaking(at: .immediate); try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }

    func tick(tasks: [MobileTask]) async {
        await refreshWeather()
        reschedule(tasks: tasks)
        let day = UserDefaults.standard.string(forKey: "lastSpokenBriefingDay") ?? ""
        if UIApplication.shared.applicationState == .active && BriefingRules.shouldSpeak(preferences: preferences, now: Date(), spokenDay: day) {
            UserDefaults.standard.set(BriefingRules.dateKey(Date()), forKey: "lastSpokenBriefingDay")
            speak(tasks: tasks)
        }
    }
    func resume(tasks: [MobileTask]) async { scheduledSignature = ""; await tick(tasks: tasks) }

    func refreshWeather(force: Bool = false) async {
        guard preferences.weather, let city = preferences.city, !weatherBusy,
              force || Date() >= weatherRetryAfter,
              force || forecast?.city != city || Date().timeIntervalSince(forecast!.fetchedAt) >= 3600 else { return }
        weatherBusy = true; defer { weatherBusy = false }
        weatherStatus = "正在获取天气预报…"
        var url = URLComponents(string: "https://api.open-meteo.com/v1/forecast")!
        url.queryItems = [URLQueryItem(name: "latitude", value: String(city.latitude)), URLQueryItem(name: "longitude", value: String(city.longitude)), URLQueryItem(name: "daily", value: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"), URLQueryItem(name: "timezone", value: TimeZone.current.identifier), URLQueryItem(name: "forecast_days", value: "14")]
        do {
            let (data, response) = try await URLSession.shared.data(for: URLRequest(url: url.url!, timeoutInterval: 15))
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            struct Response: Decodable { var daily: BriefingForecast.Days }
            let value = try JSONDecoder().decode(Response.self, from: data)
            guard !value.daily.time.isEmpty else { throw URLError(.cannotParseResponse) }
            guard city == preferences.city else { return }
            let result = BriefingForecast(city: city, fetchedAt: Date(), daily: value.daily)
            forecast = result; UserDefaults.standard.set(try JSONEncoder().encode(result), forKey: "dailyBriefingForecast")
            weatherStatus = "Open-Meteo · 更新于 " + result.fetchedAt.formatted(date: .omitted, time: .shortened)
            weatherRetryAfter = .distantPast; scheduledSignature = ""
        } catch { weatherRetryAfter = Date().addingTimeInterval(300); weatherStatus = "天气更新失败，保留已有预报 · " + error.localizedDescription }
    }

    func requestNotifications(tasks: [MobileTask]) async {
        do {
            let allowed = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            notificationStatus = allowed ? "通知已授权" : "通知未授权，请在系统设置允许"
        } catch { notificationStatus = "通知授权失败：" + error.localizedDescription }
        scheduledSignature = ""; reschedule(tasks: tasks)
    }

    func reschedule(tasks: [MobileTask]) {
        struct Input: Encodable { var preferences: BriefingPreferences; var tasks: [MobileTask]; var day: String; var forecast: Date? }
        let input = Input(preferences: preferences, tasks: tasks.sorted { $0.id < $1.id }, day: BriefingRules.dateKey(Date()), forecast: forecast?.fetchedAt)
        let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
        guard let encoded = try? encoder.encode(input) else { return }
        let signature = encoded.base64EncodedString()
        guard signature != scheduledSignature else { return }
        scheduledSignature = signature; scheduleTask?.cancel()
        scheduleTask = Task {
            let center = UNUserNotificationCenter.current()
            let settings = await center.notificationSettings()
            guard !Task.isCancelled else { return }
            let old = await center.pendingNotificationRequests()
            guard !Task.isCancelled else { return }
            center.removePendingNotificationRequests(withIdentifiers: old.filter { $0.identifier.hasPrefix("deskbox.brief.") }.map(\.identifier))
            guard preferences.reminders else { notificationStatus = "每日提醒已关闭"; return }
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { notificationStatus = "请在系统设置中允许 DeskBox 通知"; return }
            var count = 0
            for date in BriefingRules.nextDates(preferences: preferences, now: Date()) {
                guard !Task.isCancelled else { return }
                let content = UNMutableNotificationContent()
                content.title = "DeskBox · 每日工程简报"
                content.body = String(summary(tasks: tasks, on: date).prefix(1500)) + "\n根据最近同步资料，请打开应用刷新。"
                content.sound = .default
                let parts = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: date)
                let request = UNNotificationRequest(identifier: "deskbox.brief." + BriefingRules.dateKey(date), content: content, trigger: UNCalendarNotificationTrigger(dateMatching: parts, repeats: false))
                do { try await center.add(request); count += 1 }
                catch { notificationStatus = "提醒保存失败：" + error.localizedDescription; scheduledSignature = ""; return }
            }
            notificationStatus = "已安排未来\(count)天提醒；每次打开应用更新内容"
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) { completionHandler([.banner, .sound]) }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
}

struct DailyBriefingCard: View {
    @EnvironmentObject var briefing: DailyBriefing
    @EnvironmentObject var store: OfflineStore
    @State private var settings = false
    @State private var mail = false
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Label("每日工程简报", systemImage: "sun.horizon.fill").font(.headline); Spacer(); Button("设置") { settings = true } }
            Text(briefing.preferences.city.flatMap { _ in briefing.forecast?.city == briefing.preferences.city ? briefing.forecast?.text(on: Date()) : nil } ?? "选择城市，开启天气与任务简报").font(.subheadline)
            Text(briefing.preferences.reminders ? briefing.notificationStatus : "每日提醒未开启 · 可选择任务与提醒时间").font(.caption).foregroundStyle(.secondary)
            HStack {
                Button { briefing.speak(tasks: store.tasks) } label: { Label("朗读", systemImage: "speaker.wave.2.fill") }.buttonStyle(.bordered)
                Button("停止") { briefing.stopSpeaking() }.font(.caption)
                Spacer()
                if MFMailComposeViewController.canSendMail() { Button("邮件草稿") { mail = true }.buttonStyle(.bordered) }
                else { ShareLink(item: briefing.summary(tasks: store.tasks)) { Label("分享简报", systemImage: "square.and.arrow.up") }.font(.caption) }
            }
        }.padding().background(Color(red: 0.055, green: 0.09, blue: 0.15), in: RoundedRectangle(cornerRadius: 18))
        .sheet(isPresented: $settings) { DailyBriefingSettingsView() }
        .sheet(isPresented: $mail) { BriefingMailComposer(recipient: briefing.preferences.email, messageBody: briefing.summary(tasks: store.tasks)) }
    }
}

struct DailyBriefingSettingsView: View {
    @EnvironmentObject var briefing: DailyBriefing
    @EnvironmentObject var store: OfflineStore
    @Environment(\.dismiss) private var dismiss
    @State private var cityQuery = ""
    @State private var cities: [BriefingCity] = []
    @State private var searching = false
    @State private var searchError = ""
    private var time: Binding<Date> {
        Binding(get: { Calendar.current.date(bySettingHour: briefing.preferences.hour, minute: briefing.preferences.minute, second: 0, of: Date()) ?? Date() }, set: { let parts = Calendar.current.dateComponents([.hour, .minute], from: $0); briefing.preferences.hour = parts.hour ?? 8; briefing.preferences.minute = parts.minute ?? 30 })
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("每天提醒哪些任务") {
                    Toggle("每日系统通知", isOn: $briefing.preferences.reminders)
                    DatePicker("提醒时间", selection: time, displayedComponents: .hourAndMinute)
                    Toggle("周末也提醒", isOn: $briefing.preferences.weekends)
                    Picker("任务范围", selection: $briefing.preferences.taskMode) { Text("当天到期和逾期").tag("due"); Text("全部未完成").tag("all"); Text("高优先级").tag("high"); Text("我选择的任务").tag("selected") }
                    Text(briefing.notificationStatus).font(.caption).foregroundStyle(.secondary)
                    Button("打开系统通知设置") { if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) } }
                    Text("提前安排未来14天内的提醒，内容来自最近同步快照。打开应用会更新；长期不打开将停止生成新的提醒。").font(.caption).foregroundStyle(.secondary)
                }
                if briefing.preferences.taskMode == "selected" {
                    Section("选择任务（已完成任务自动排除）") {
                        ForEach(store.tasks.filter { $0.status != "done" }) { task in
                            Toggle(task.title, isOn: Binding(get: { briefing.preferences.selectedTaskIds.contains(task.id) }, set: { selected in briefing.preferences.selectedTaskIds.removeAll { $0 == task.id }; if selected { briefing.preferences.selectedTaskIds.append(task.id) } }))
                        }
                    }
                }
                Section("天气与语音") {
                    Toggle("简报包含天气", isOn: $briefing.preferences.weather)
                    Text(briefing.preferences.city?.label ?? "尚未选择城市").font(.caption).foregroundStyle(.cyan)
                    HStack { TextField("搜索城市，例如上海", text: $cityQuery); Button(searching ? "搜索中" : "搜索") { Task { await searchCities() } }.disabled(searching || cityQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
                    if !searchError.isEmpty { Text(searchError).font(.caption).foregroundStyle(.orange) }
                    ForEach(cities) { city in Button(city.label) { briefing.preferences.city = city; cities = []; Task { await briefing.refreshWeather(force: true); briefing.reschedule(tasks: store.tasks) } } }
                    Text(briefing.weatherStatus).font(.caption).foregroundStyle(.secondary)
                    Button("刷新天气预报") { Task { await briefing.refreshWeather(force: true); briefing.reschedule(tasks: store.tasks) } }.disabled(briefing.weatherBusy || briefing.preferences.city == nil)
                    Toggle("每天前台自动朗读一次", isOn: $briefing.preferences.autoSpeak)
                    Text("达到提醒时间后，在应用前台朗读。锁屏和退出应用使用系统通知提示，不保证定时自动播放语音。天气由 Open-Meteo 提供。").font(.caption).foregroundStyle(.secondary)
                }
                Section("日报邮件") {
                    TextField("默认收件邮箱（可空）", text: $briefing.preferences.email).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Text("首页生成含任务和天气的邮件草稿，由你确认收件人并发送。未配置系统邮件时可分享给邮件应用；暂不读取收件箱。").font(.caption).foregroundStyle(.secondary)
                }
            }.navigationTitle("每日简报设置")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { briefing.reschedule(tasks: store.tasks); dismiss() } } }
            .onChange(of: briefing.preferences.reminders) { _, enabled in if enabled { Task { await briefing.requestNotifications(tasks: store.tasks) } } else { briefing.reschedule(tasks: store.tasks) } }
        }
    }
    private func searchCities() async {
        searching = true; searchError = ""; defer { searching = false }
        var url = URLComponents(string: "https://geocoding-api.open-meteo.com/v1/search")!
        url.queryItems = [URLQueryItem(name: "name", value: cityQuery.trimmingCharacters(in: .whitespacesAndNewlines)), URLQueryItem(name: "count", value: "8"), URLQueryItem(name: "language", value: "zh")]
        do {
            let (data, response) = try await URLSession.shared.data(for: URLRequest(url: url.url!, timeoutInterval: 15))
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            struct Response: Decodable { var results: [BriefingCity]? }
            cities = try JSONDecoder().decode(Response.self, from: data).results ?? []
            if cities.isEmpty { searchError = "未找到城市，请换一个城市名搜索" }
        } catch { cities = []; searchError = "城市搜索失败：" + error.localizedDescription }
    }
}

struct BriefingMailComposer: UIViewControllerRepresentable {
    @Environment(\.dismiss) private var dismiss
    var recipient: String
    var messageBody: String
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIViewController(context: Context) -> MFMailComposeViewController {
        let controller = MFMailComposeViewController(); controller.mailComposeDelegate = context.coordinator
        if !recipient.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { controller.setToRecipients([recipient]) }
        controller.setSubject("DeskBox 工程日报 · " + BriefingRules.dateKey(Date()))
        controller.setMessageBody(messageBody, isHTML: false); return controller
    }
    func updateUIViewController(_ controller: MFMailComposeViewController, context: Context) {}
    final class Coordinator: NSObject, MFMailComposeViewControllerDelegate {
        var parent: BriefingMailComposer
        init(_ parent: BriefingMailComposer) { self.parent = parent }
        func mailComposeController(_ controller: MFMailComposeViewController, didFinishWith result: MFMailComposeResult, error: Error?) { parent.dismiss() }
    }
}

