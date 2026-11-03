import Foundation
import Combine

struct MobileAIMessage: Codable, Identifiable {
    var id = UUID().uuidString
    var role: String
    var content: String
    var error = ""
}
struct CloudAIResult: Decodable {
    var id: String
    var status: String
    var response: String
    var stage: String
    var error: String
    var provider: String
    var model: String
}

@MainActor final class MobileAIService: ObservableObject {
    @Published private(set) var messages: [MobileAIMessage] = []
    @Published private(set) var busy = false
    @Published private(set) var stage = "就绪 · 使用电脑端配置的AI服务商"
    @Published private(set) var provider = ""
    @Published private(set) var model = ""
    @Published private(set) var error = ""
    @Published private(set) var completedReply: String?
    private var operation: Task<Void, Never>?
    private let historyURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("mobile-ai-history.json")
    private var savedAt = Date.distantPast
    private var jobId: String? { get { UserDefaults.standard.string(forKey: "mobileAIJob") } set { UserDefaults.standard.set(newValue, forKey: "mobileAIJob") } }
    private var assistantId: String? { get { UserDefaults.standard.string(forKey: "mobileAIAssistant") } set { UserDefaults.standard.set(newValue, forKey: "mobileAIAssistant") } }
    init() { if let data = try? Data(contentsOf: historyURL), let value = try? JSONDecoder().decode([MobileAIMessage].self, from: data) { messages = value } }
    private func save() { do { try JSONEncoder().encode(Array(messages.suffix(60))).write(to: historyURL, options: .atomic); savedAt = Date() } catch { self.error = "AI历史保存失败，当前内容仍保留在内存" } }
    func send(_ text: String, sync: SyncClient) {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !busy else { return }
        guard jobId == nil else { error = "还有尚未确认的请求，请先恢复查看或取消"; return }
        guard sync.cloudCredential != nil else { error = "请先在连接设置登录云账号；手机AI通过已授权电脑处理"; return }
        guard value.count <= 16000 else { error = "内容超过16000字符，请缩小范围"; return }
        error = ""; messages.append(MobileAIMessage(role: "user", content: value))
        var budget = 50000
        var history: [[String: String]] = []
        for message in messages.suffix(12).reversed() where !message.content.isEmpty && message.error.isEmpty { let content = String(message.content.prefix(min(16000, budget))); if !content.isEmpty { history.insert(["Role": message.role, "Content": content], at: 0); budget -= content.count } }
        let assistant = MobileAIMessage(role: "assistant", content: ""); messages.append(assistant); assistantId = assistant.id
        let id = UUID().uuidString.lowercased(); jobId = id; save(); busy = true; stage = "提交请求 · 等待电脑接入"
        operation = Task {
            do {
                let body = try JSONSerialization.data(withJSONObject: ["Id": id, "Messages": history])
                _ = try await sync.mobileAIRequest("ai-request", body: body)
                await poll(id: id, sync: sync)
            } catch { if !Task.isCancelled { self.error = error.localizedDescription; stage = "连接中断 · 返回页面可恢复"; busy = false; save() } }
        }
    }
    func resume(sync: SyncClient) {
        guard !busy, let id = jobId, sync.cloudCredential != nil else { return }
        busy = true; error = ""; operation = Task { await poll(id: id, sync: sync) }
    }
    private func poll(id: String, sync: SyncClient) async {
        do {
            while !Task.isCancelled {
                let data = try await sync.mobileAIRequest("ai-request?id=" + id)
                let result = try JSONDecoder().decode(CloudAIResult.self, from: data)
                stage = result.stage; provider = result.provider; model = result.model
                if let index = messages.firstIndex(where: { $0.id == assistantId }) { messages[index].content = result.response; messages[index].error = result.error }
                if Date().timeIntervalSince(savedAt) >= 2 { save() }
                if ["completed", "error", "cancelled"].contains(result.status) { error = result.error; busy = false; jobId = nil; if result.status == "completed" { completedReply = assistantId }; save(); return }
                try await Task.sleep(nanoseconds: 1_000_000_000)
            }
        } catch { if !Task.isCancelled { self.error = error.localizedDescription; stage = "网络中断，已有内容保留"; busy = false; if (error as NSError).code == 404 { jobId = nil }; save() } }
    }
    func cancel(sync: SyncClient) {
        guard let id = jobId else { return }
        operation?.cancel(); busy = true; stage = "正在通知电脑取消"
        Task { do { _ = try await sync.mobileAIRequest("ai-cancel", body: JSONSerialization.data(withJSONObject: ["Id": id])); if jobId == id { jobId = nil }; stage = "已取消 · 已有内容保留" } catch { self.error = "取消未能确认，请联网后重试" }; busy = false; save() }
    }
    func suspend() { operation?.cancel(); busy = false; if jobId != nil { stage = "电脑继续处理，回到前台可恢复查看" } }
    func newConversation() { guard !busy, jobId == nil else { return }; messages = []; error = ""; stage = "新对话"; save() }
}
