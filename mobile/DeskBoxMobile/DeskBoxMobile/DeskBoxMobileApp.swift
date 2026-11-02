import SwiftUI
import Combine

@main struct DeskBoxMobileApp: App {
    @StateObject private var store = OfflineStore()
    @StateObject private var sync = SyncClient()
    var body: some Scene { WindowGroup { RootView().environmentObject(store).environmentObject(sync).preferredColorScheme(.dark) } }
}

struct RootView: View {
    @EnvironmentObject var store: OfflineStore
    @EnvironmentObject var sync: SyncClient
    @Environment(\.scenePhase) private var scenePhase
    @State private var selectedTab = 0
    var body: some View {
        TabView(selection: $selectedTab) {
            HomeView(onNavigate: { selectedTab = $0 }).tabItem { Label("首页", systemImage: "square.grid.2x2") }.tag(0)
            TasksView().disabled(store.loadFailed).tabItem { Label("任务", systemImage: "checkmark.circle") }.tag(1)
            ProjectsView().tabItem { Label("项目", systemImage: "folder") }.tag(2)
            IncidentView().disabled(store.loadFailed).tabItem { Label("事件", systemImage: "exclamationmark.triangle") }.tag(3)
            MobileAIView().tabItem { Label("AI", systemImage: "sparkles") }.tag(4)
        }
        .tint(.cyan).toolbarBackground(.visible, for: .tabBar)
        .safeAreaInset(edge: .top) { if !store.storageError.isEmpty { Text(store.storageError).font(.caption).foregroundStyle(.red).padding().frame(maxWidth: .infinity).background(Color.black) } }
        .task {
            while !Task.isCancelled {
                if scenePhase == .active { sync.automaticSync(store: store) }
                do { try await Task.sleep(nanoseconds: 15_000_000_000) } catch { break }
            }
        }
        .onChange(of: scenePhase) { _, value in if value == .active { sync.automaticSync(store: store, force: true) } }
        .onChange(of: sync.credentials?.deviceId) { _, _ in sync.automaticSync(store: store, force: true) }
        .onChange(of: sync.networkEpoch) { _, _ in if scenePhase == .active { sync.automaticSync(store: store, force: true) } }
        .onChange(of: sync.automatic) { _, enabled in if enabled && scenePhase == .active { sync.automaticSync(store: store, force: true) } }
        .onReceive(store.$pending.debounce(for: .milliseconds(900), scheduler: RunLoop.main)) { pending in
            if !pending.isEmpty && scenePhase == .active { sync.automaticSync(store: store, force: sync.connected) }
        }
    }
}

struct HomeView: View {
    @EnvironmentObject var store: OfflineStore
    @EnvironmentObject var sync: SyncClient
    @AppStorage("selectedMobileProject") private var projectId = ""
    @State private var connectionSettings = false
    var onNavigate: (Int) -> Void
    private var currentProject: MobileProject? { store.projects.first(where: { $0.id == projectId }) ?? store.projects.first }
    private var openTasks: [MobileTask] { store.tasks.filter { $0.status != "done" }.sorted { $0.priority == "high" && $1.priority != "high" } }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack {
                        Image("BrandMark").resizable().scaledToFit().frame(width: 42, height: 42).clipShape(RoundedRectangle(cornerRadius: 10))
                        VStack(alignment: .leading, spacing: 5) {
                            Text("ENGINEERING WORKSPACE").font(.caption.monospaced()).foregroundStyle(.cyan)
                            Text("工程随行工作台").font(.title2.bold())
                        }
                        Spacer()
                        if sync.busy { ProgressView() }
                        Image(systemName: sync.connected ? "checkmark.icloud.fill" : "icloud.slash").foregroundStyle(sync.connected ? Color.green : Color.gray)
                    }
                    projectPanel
                    HStack(spacing: 12) {
                        metric("未完成任务", value: openTasks.count, color: .cyan)
                        metric("高优先级", value: openTasks.filter { $0.priority == "high" }.count, color: .orange)
                    }
                    VStack(alignment: .leading, spacing: 10) {
                        HStack { Label("同步与连接", systemImage: "arrow.triangle.2.circlepath").font(.headline); Spacer(); Text(sync.automatic ? "自动" : "手动").foregroundStyle(.cyan) }
                        Text(sync.status).font(.subheadline).foregroundStyle(.secondary)
                        HStack {
                            Text("待上传 \(store.pending.count) 条")
                            Spacer()
                            if let date = sync.lastSyncedAt { Text(date, style: .time) }
                        }.font(.caption).foregroundStyle(.secondary)
                        if sync.credentials == nil { Button("首次连接电脑") { connectionSettings = true }.buttonStyle(.borderedProminent) }
                    }.padding().background(panelColor, in: RoundedRectangle(cornerRadius: 18))
                    HStack(spacing: 12) {
                        shortcut("工程任务", detail: "编辑 · 提醒 · 完成", icon: "checklist", tab: 1)
                        shortcut("项目资料", detail: "进度 · 设备 · 客户", icon: "folder.badge.gearshape", tab: 2)
                    }
                    HStack(spacing: 12) {
                        shortcut("现场事件", detail: "记录问题 · 离线保存", icon: "exclamationmark.bubble", tab: 3)
                        shortcut("AI 助手", detail: "中继功能待完成", icon: "sparkles", tab: 4)
                    }
                    HStack { Text("当前待办").font(.headline); Spacer(); Button("全部任务") { onNavigate(1) }.font(.caption) }
                    if openTasks.isEmpty { Text("当前没有未完成任务").foregroundStyle(.secondary) }
                    ForEach(Array(openTasks.prefix(4))) { task in
                        HStack(alignment: .top) {
                            Image(systemName: task.priority == "high" ? "exclamationmark.circle.fill" : "circle").foregroundStyle(task.priority == "high" ? .orange : .cyan)
                            VStack(alignment: .leading, spacing: 4) { Text(task.title); if !task.due.isEmpty { Text("截止 " + task.due).font(.caption).foregroundStyle(.secondary) } }
                            Spacer()
                        }.padding().frame(maxWidth: .infinity, alignment: .leading).background(panelColor, in: RoundedRectangle(cornerRadius: 14))
                    }
                }.padding()
            }
            .background(Color(red: 0.02, green: 0.04, blue: 0.08))
            .navigationTitle("DeskBox").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { connectionSettings = true } label: { Image(systemName: "network") } } }
            .sheet(isPresented: $connectionSettings) { ConnectionSettingsView() }
        }
    }
    private var panelColor: Color { Color(red: 0.055, green: 0.09, blue: 0.15) }
    private var projectPanel: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack { Text("当前项目").font(.caption).foregroundStyle(.cyan); Spacer(); Button("查看") { onNavigate(2) }.font(.caption) }
            if let project = currentProject {
                Text(project.name).font(.title3.bold())
                Text(project.number + (project.equipment.isEmpty ? "" : " · " + project.equipment)).font(.caption).foregroundStyle(.secondary)
                HStack {
                    if project.progressApplicable == false { Text("N/A").font(.title.bold()).foregroundStyle(.cyan) }
                    else { ProgressView(value: min(100, max(0, project.progress)), total: 100).tint(.cyan); Text("\(Int(project.progress))%").font(.title3.monospacedDigit().bold()) }
                }
                if store.projects.count > 1 {
                    Picker("切换项目", selection: Binding(get: { currentProject?.id ?? "" }, set: { projectId = $0 })) { ForEach(store.projects) { Text($0.name).tag($0.id) } }.pickerStyle(.menu)
                }
            } else { Text("尚未同步项目").font(.title3); Text("连接电脑后将自动加载项目进度").font(.caption).foregroundStyle(.secondary) }
        }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
        .background(LinearGradient(colors: [Color(red: 0.04, green: 0.16, blue: 0.22), panelColor], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(.cyan.opacity(0.25)))
    }
    private func metric(_ title: String, value: Int, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 6) { Text(title).font(.caption).foregroundStyle(.secondary); Text("\(value)").font(.title.bold().monospacedDigit()).foregroundStyle(color) }.padding().frame(maxWidth: .infinity, alignment: .leading).background(panelColor, in: RoundedRectangle(cornerRadius: 16))
    }
    private func shortcut(_ title: String, detail: String, icon: String, tab: Int) -> some View {
        Button { onNavigate(tab) } label: { VStack(alignment: .leading, spacing: 8) { Image(systemName: icon).font(.title3).foregroundStyle(.cyan); Text(title).font(.headline).foregroundStyle(.primary); Text(detail).font(.caption).foregroundStyle(.secondary) }.padding().frame(maxWidth: .infinity, alignment: .leading).background(panelColor, in: RoundedRectangle(cornerRadius: 16)) }.buttonStyle(.plain)
    }
}

struct ConnectionSettingsView: View {
    @EnvironmentObject var store: OfflineStore
    @EnvironmentObject var sync: SyncClient
    @Environment(\.dismiss) private var dismiss
    @State private var pairing = ""
    @State private var host = ""
    @State private var port = "47831"
    @State private var confirmReset = false
    var body: some View {
        NavigationStack {
            Form {
                Section("自动同步") {
                    Toggle("自动连接与同步", isOn: $sync.automatic)
                    Text("应用回到前台、网络恢复、编辑后自动同步；前台每15秒刷新。iOS长期后台或被结束后不能保证持续运行。").font(.caption).foregroundStyle(.secondary)
                    Text(sync.status).font(.caption)
                    Button("立即同步") { sync.sync(store: store) }.disabled(sync.credentials == nil || sync.busy)
                }
                if let credentials = sync.credentials {
                    Section("已记住此电脑") {
                        LabeledContent("地址", value: credentials.host + ":" + String(credentials.port))
                        Text("无需重复配对。证书更换、设备撤销、长期过期或清除配对后才需重新建立信任。").font(.caption)
                    }
                    Section("跨网络 / 地址变更") {
                        TextField("固定IP或主机名（不带https://）", text: $host).textInputAutocapitalization(.never).autocorrectionDisabled()
                        TextField("端口", text: $port).keyboardType(.numberPad)
                        Button("保存地址，保留当前配对") { if let number = Int(port), sync.updateEndpoint(host: host, port: number) { sync.automaticSync(store: store, force: true) } }.disabled(sync.busy)
                        Text("不同网络需先在电脑与手机建立Tailscale/ZeroTier等私有网络，再填写电脑固定虚拟IP。这里只更新连接地址，不提供公网中继，也不会跳过原电脑的证书校验。").font(.caption).foregroundStyle(.secondary)
                    }
                }
                Section(sync.credentials == nil ? "首次配对" : "重新配对（通常不需要）") {
                    TextField("电脑端完整deskbox://配对链接", text: $pairing).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    Button("连接电脑") { _ = sync.configure(uri: pairing) }.disabled(sync.busy || pairing.isEmpty)
                }
                if sync.credentials != nil {
                    Section { Button("清除此手机配对", role: .destructive) { confirmReset = true }.disabled(sync.busy) }
                }
                Section("版本") { Text(versionLabel).font(.caption) }
            }.navigationTitle("连接设置")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .onAppear { host = sync.credentials?.host ?? ""; port = String(sync.credentials?.port ?? 47831) }
            .alert("清除配对？离线数据仍保留", isPresented: $confirmReset) { Button("清除", role: .destructive) { sync.disconnect() }; Button("取消", role: .cancel) {} }
        }
    }
    private var versionLabel: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "—"
        return "\(version) (\(build))"
    }
}

struct TasksView: View {
    @EnvironmentObject var store: OfflineStore
    @State private var title = ""
    @State private var query = ""
    @State private var filter = 0
    @State private var editing: MobileTask?
    @State private var deleting: MobileTask?
    @State private var confirmDelete = false
    private var visible: [MobileTask] {
        store.tasks.filter { task in
            (filter == 0 || (filter == 1 ? task.status != "done" : task.status == "done")) &&
            (query.isEmpty || (task.title + " " + task.notes).localizedCaseInsensitiveContains(query))
        }.sorted { a, b in let doneA = a.status == "done", doneB = b.status == "done"; return doneA == doneB ? a.title < b.title : !doneA }
    }
    var body: some View {
        NavigationStack {
            VStack {
                HStack {
                    TextField("新增工程任务", text: $title).textFieldStyle(.roundedBorder)
                    Button("添加") {
                        let value = title.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !value.isEmpty else { return }
                        store.updateTask(MobileTask(title: value)); title = ""
                    }.disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }.padding(.horizontal)
                Picker("状态", selection: $filter) { Text("全部").tag(0); Text("未完成").tag(1); Text("已完成").tag(2) }.pickerStyle(.segmented).padding(.horizontal)
                Text("待上传 \(store.pending.count) 条 · 已保存到本机，开启自动同步后自动提交").font(.caption).foregroundStyle(.secondary)
                List(visible) { task in
                    HStack {
                        Button {
                            var value = task; value.status = task.status == "done" ? "open" : "done"; store.updateTask(value)
                        } label: { Image(systemName: task.status == "done" ? "checkmark.circle.fill" : "circle").foregroundStyle(.cyan) }.buttonStyle(.borderless)
                        Button { editing = task } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(task.title).foregroundStyle(.primary)
                                Text((task.priority == "high" ? "高优先级 · " : "") + (task.due.isEmpty ? "无截止日期" : task.due)).font(.caption).foregroundStyle(.secondary)
                                if !task.notes.isEmpty { Text(task.notes).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                            }
                        }.buttonStyle(.plain)
                    }
                    .swipeActions {
                        Button("删除", role: .destructive) { deleting = task; confirmDelete = true }
                        Button("编辑") { editing = task }.tint(.cyan)
                    }
                }
            }
            .searchable(text: $query, prompt: "搜索任务标题与备注")
            .navigationTitle("工程任务")
            .sheet(item: $editing) { task in TaskEditor(task: task) }
            .confirmationDialog("删除后将在下次同步时提交删除标记，是否继续？", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("删除任务", role: .destructive) { if let task = deleting { store.deleteTask(task.id) }; deleting = nil }
                Button("取消", role: .cancel) { deleting = nil }
            }
        }
    }
}

struct TaskEditor: View {
    @EnvironmentObject var store: OfflineStore
    @Environment(\.dismiss) private var dismiss
    @State private var task: MobileTask
    @State private var error = ""
    init(task: MobileTask) { _task = State(initialValue: task) }
    var body: some View {
        NavigationStack {
            Form {
                TextField("任务标题", text: $task.title)
                Picker("项目", selection: $task.projectId) {
                    Text("未分配项目").tag("")
                    if !task.projectId.isEmpty && !store.projects.contains(where: { $0.id == task.projectId }) { Text("原项目（待同步）").tag(task.projectId) }
                    ForEach(store.projects) { project in Text(project.name).tag(project.id) }
                }
                Picker("优先级", selection: $task.priority) { Text("低").tag("low"); Text("普通").tag("normal"); Text("高").tag("high") }
                TextField("截止日期 yyyy-MM-dd（可空）", text: $task.due).textInputAutocapitalization(.never)
                TextField("备注 / 验证要求", text: $task.notes, axis: .vertical).lineLimit(4...10)
                Toggle("已完成", isOn: Binding(get: { task.status == "done" }, set: { task.status = $0 ? "done" : "open" }))
                if !error.isEmpty { Text(error).foregroundStyle(.red) }
            }.navigationTitle("编辑任务")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        task.title = task.title.trimmingCharacters(in: .whitespacesAndNewlines)
                        task.due = task.due.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !task.title.isEmpty else { error = "任务标题不能为空"; return }
                        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
                        if !task.due.isEmpty {
                            guard let date = formatter.date(from: task.due), formatter.string(from: date) == task.due else { error = "截止日期应为有效的 yyyy-MM-dd"; return }
                        }
                        store.updateTask(task); dismiss()
                    }
                }
            }
        }
    }
}

struct ProjectsView: View {
    @EnvironmentObject var store: OfflineStore
    @State private var query = ""
    private var visible: [MobileProject] { store.projects.filter { query.isEmpty || "\($0.name) \($0.number) \($0.customer) \($0.equipment)".localizedCaseInsensitiveContains(query) } }
    var body: some View {
        NavigationStack {
            List(visible) { project in
                NavigationLink {
                    Form {
                        Section("项目进度") {
                            Text(project.name).font(.headline)
                            Text(project.progressApplicable == false ? "N/A · 不适用" : "\(Int(project.progress))% 已完成").foregroundStyle(.cyan)
                            if project.progressApplicable != false { ProgressView(value: project.progress, total: 100).tint(.cyan) }
                        }
                        Section("工程信息") {
                            LabeledContent("项目编号", value: project.number.isEmpty ? "未填写" : project.number)
                            LabeledContent("客户", value: project.customer.isEmpty ? "未填写" : project.customer)
                            LabeledContent("设备", value: project.equipment.isEmpty ? "未填写" : project.equipment)
                            LabeledContent("负责人", value: project.owner.isEmpty ? "未填写" : project.owner)
                            LabeledContent("截止日期", value: project.deadline.isEmpty ? "未设置" : project.deadline)
                        }
                        Section("相关任务") {
                            let tasks = store.tasks.filter { $0.projectId == project.id }
                            if tasks.isEmpty { Text("暂无关联任务").foregroundStyle(.secondary) }
                            ForEach(tasks) { task in Label(task.title, systemImage: task.status == "done" ? "checkmark.circle.fill" : "circle").foregroundStyle(task.status == "done" ? Color.secondary : Color.primary) }
                        }
                    }.navigationTitle("项目详情").navigationBarTitleDisplayMode(.inline)
                } label: {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Image(systemName: "square.stack.3d.up.fill").foregroundStyle(.cyan)
                            Text(project.name).font(.headline)
                            Spacer()
                            Text(project.progressApplicable == false ? "N/A" : "\(Int(project.progress))%").font(.headline.monospacedDigit()).foregroundStyle(.cyan)
                        }
                        if project.progressApplicable != false { ProgressView(value: project.progress, total: 100).tint(.cyan) }
                        Text([project.number, project.customer, project.equipment].filter { !$0.isEmpty }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                    }.padding(.vertical, 8)
                }
            }
            .overlay { if visible.isEmpty { ContentUnavailableView("暂无匹配项目", systemImage: "folder", description: Text("项目资料来自电脑同步，可按编号、客户或设备搜索。")) } }
            .searchable(text: $query, prompt: "搜索项目、编号、客户或设备")
            .navigationTitle("工程项目")
        }
    }
}

struct IncidentView: View {
    @EnvironmentObject var store: OfflineStore
    @State private var description = ""
    @State private var severity = "S3"
    var body: some View {
        NavigationStack {
            Form {
                Section("记录现场事件") {
                    Picker("严重程度", selection: $severity) { ForEach(["S1", "S2", "S3", "S4"], id: \.self) { Text($0) } }.pickerStyle(.segmented)
                    TextField("描述故障现象、设备状态与现场处理", text: $description, axis: .vertical).lineLimit(4...10)
                    Button("保存事件 · 自动同步") {
                        var incident = Incident(); incident.description = description.trimmingCharacters(in: .whitespacesAndNewlines); incident.severity = severity
                        store.incidents.append(incident); store.queue("incident", id: incident.id, value: incident); description = ""
                    }.disabled(description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Text("离线内容保存在本机，开启自动同步后提交到电脑。").font(.caption).foregroundStyle(.secondary)
                }
                Section("现场记录 · \(store.incidents.count)") {
                    if store.incidents.isEmpty { Label("暂无事件记录", systemImage: "checkmark.shield").foregroundStyle(.secondary) }
                    ForEach(store.incidents) { incident in
                        VStack(alignment: .leading, spacing: 8) {
                            Label(incident.severity, systemImage: "exclamationmark.triangle.fill").font(.caption.bold()).foregroundStyle(.orange)
                            Text(incident.description)
                            Text(incident.status == "open" ? "待处理" : incident.status).font(.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 6)
                    }
                }
            }.navigationTitle("现场事件")
        }
    }
}

struct MobileAIView: View { var body: some View { NavigationStack { ContentUnavailableView("手机 AI 中继待接入",systemImage:"sparkles",description:Text("电脑端 AI&SI 可用；手机对话需要完成带设备授权的流式中继接口，当前版本尚未开放。" )).navigationTitle("AI&SI") } } }

