import SwiftUI

struct MobileAIView: View {
    @EnvironmentObject var sync: SyncClient
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var ai = MobileAIService()
    @StateObject private var voice = VoiceConversation()
    @State private var draft = ""
    @State private var voiceMode = false
    @State private var follow = true
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack { Label("工程 AI&SI", systemImage: "sparkles").foregroundStyle(.purple); Spacer(); if ai.busy { ProgressView() } }
                    Text(ai.stage).font(.caption).foregroundStyle(.cyan)
                    if !ai.provider.isEmpty { Text(ai.provider + " · " + ai.model).font(.caption2).foregroundStyle(.secondary) }
                    if sync.cloudCredential == nil { Text("先在首页连接设置登录云账号；电脑需保持DeskBox运行。").font(.caption).foregroundStyle(.orange) }
                    if !ai.error.isEmpty { Text(ai.error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
                }.padding().frame(maxWidth: .infinity, alignment: .leading).background(Color(red: 0.05, green: 0.09, blue: 0.16))
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 16) {
                            if ai.messages.isEmpty { ContentUnavailableView("随行工程助手", systemImage: "sparkles", description: Text("查询任务、项目、现场事件和电脑已授权的工程文档。手机通道当前提供查询分析，写入操作在电脑确认。")) }
                            ForEach(ai.messages) { message in
                                VStack(alignment: .leading, spacing: 8) {
                                    Label(message.role == "user" ? "我" : "AI&SI", systemImage: message.role == "user" ? "person.circle" : "sparkles").font(.caption.bold()).foregroundStyle(message.role == "user" ? .cyan : .purple)
                                    Text(message.content.isEmpty && ai.busy ? "正在等待电脑和模型响应…" : message.content).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                                    if !message.error.isEmpty { Text(message.error).font(.caption).foregroundStyle(.red) }
                                    if message.role == "assistant" && !message.content.isEmpty { HStack { Button { UIPasteboard.general.string = message.content } label: { Label("复制", systemImage: "doc.on.doc") }; Button { voice.speak(message.content) } label: { Label("朗读", systemImage: "speaker.wave.2") } }.font(.caption) }
                                }.padding().background(message.role == "user" ? Color.cyan.opacity(0.08) : Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 16)).id(message.id)
                            }
                        }.padding()
                    }.onChange(of: ai.messages.last?.content) { _, _ in if follow, let last = ai.messages.last { proxy.scrollTo(last.id, anchor: .bottom) } }
                }
                VStack(spacing: 10) {
                    HStack { Toggle("连续语音对话", isOn: $voiceMode).font(.caption); Spacer(); if voice.listening { Text("聆听中").font(.caption).foregroundStyle(.cyan) } }
                    if voiceMode || voice.listening { Text(voice.status).font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading) }
                    HStack(alignment: .bottom) {
                        Button { if voice.listening { voice.stopRecording() } else { Task { await voice.start() } } } label: { Image(systemName: voice.listening ? "stop.circle.fill" : "mic.fill").font(.title2).foregroundStyle(voice.listening ? .red : .cyan) }.disabled(ai.busy)
                        TextField("输入问题，或点击麦克风", text: $draft, axis: .vertical).lineLimit(2...6).padding(10).background(Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
                        if ai.busy { Button("取消") { voice.stop(); ai.cancel(sync: sync) } }
                        else { Button { send() } label: { Image(systemName: "arrow.up.circle.fill").font(.title) }.disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sync.cloudCredential == nil) }
                    }
                    Text("API Key保留在电脑；前台展示真实查询/接收进度，离开页面后可恢复。").font(.caption2).foregroundStyle(.secondary)
                }.padding().background(Color(red: 0.05, green: 0.08, blue: 0.13))
            }.navigationTitle("AI&SI").navigationBarTitleDisplayMode(.inline)
            .toolbar { Menu { Button("新对话") { voice.stop(); ai.newConversation() }.disabled(ai.busy); Toggle("跟随输出", isOn: $follow); Button("恢复当前请求") { ai.resume(sync: sync) }; Button("停止朗读") { voice.stop() } } label: { Image(systemName: "ellipsis.circle") } }
            .task { ai.resume(sync: sync); voice.onFinal = { text in draft = text; if voiceMode { send() } } }
            .onChange(of: voice.transcript) { _, text in if voice.listening { draft = text } }
            .onChange(of: voiceMode) { _, value in voice.continuous = value; if value && !ai.busy { Task { await voice.start() } } else if !value { voice.stop() } }
            .onChange(of: ai.completedReply) { _, value in if value != nil && voiceMode && ai.error.isEmpty, let reply = ai.messages.last, reply.role == "assistant", !reply.content.isEmpty { voice.continuous = true; voice.speak(reply.content) } }
            .onChange(of: scenePhase) { _, value in if value == .active { ai.resume(sync: sync) } else { ai.suspend(); voice.stop() } }
            .onDisappear { ai.suspend(); voice.stop(); voice.onFinal = nil }
        }
    }
    private func send() { let text = draft; guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }; voice.stopRecording(); ai.send(text, sync: sync); if ai.busy { draft = "" } }
}
