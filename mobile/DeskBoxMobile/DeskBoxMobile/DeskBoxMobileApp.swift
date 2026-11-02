import SwiftUI

@main struct DeskBoxMobileApp: App {
    @StateObject private var store = OfflineStore()
    @StateObject private var sync = SyncClient()
    var body: some Scene { WindowGroup { RootView().environmentObject(store).environmentObject(sync).preferredColorScheme(.dark) } }
}

struct RootView: View {
    @EnvironmentObject var store: OfflineStore; @EnvironmentObject var sync: SyncClient
    var body: some View {
        TabView {
            HomeView().tabItem { Label("HOME", systemImage: "square.grid.2x2") }
            TasksView().disabled(store.loadFailed).tabItem { Label("TASKS", systemImage: "checkmark.circle") }
            ProjectsView().tabItem { Label("PROJECTS", systemImage: "folder") }
            IncidentView().disabled(store.loadFailed).tabItem { Label("INCIDENT", systemImage: "exclamationmark.triangle") }
            MobileAIView().tabItem { Label("AI", systemImage: "sparkles") }
        }.tint(Color(red: 0.25, green: 0.85, blue: 1)).toolbarBackground(.visible, for: .tabBar)
        .safeAreaInset(edge: .top) { if !store.storageError.isEmpty { Text(store.storageError).font(.caption).foregroundStyle(.red).padding().frame(maxWidth: .infinity).background(.background) } }
    }
}

struct HomeView: View {
    @FocusState private var pairingFocused: Bool
    @EnvironmentObject var store: OfflineStore; @EnvironmentObject var sync: SyncClient; @State private var pairing = ""; @State private var disconnecting = false
    var body: some View { NavigationStack { ScrollView { VStack(spacing: 14) {
        panel("CURRENT PROJECT", store.projects.first?.name ?? "No project synced")
        HStack { panel("TODAY", "\(store.tasks.filter{$0.status != "done"}.count) open"); panel("URGENT", "\(store.tasks.filter{$0.priority == "high"}.count) high") }
        panel("SYNC", sync.status)
        if sync.busy { ProgressView("正在与电脑交换数据…") }
        Text("待上传 \(store.pending.count) 条 · 失败时保留本地内容").font(.caption).foregroundStyle(.secondary)
        if !sync.pairingAddress.isEmpty { Text("正在连接电脑：" + sync.pairingAddress).font(.caption).foregroundStyle(.cyan) }
        TextField("粘贴完整配对链接（不只是六位码）", text: $pairing).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL).textFieldStyle(.roundedBorder).focused($pairingFocused)
        Button("PAIR WITH WINDOWS") { pairingFocused = false; _ = sync.configure(uri: pairing) }.buttonStyle(.borderedProminent).disabled(sync.busy)
        Button("SYNC NOW") { sync.sync(store: store) }.buttonStyle(.bordered).disabled(sync.credentials == nil || sync.busy)
        if sync.credentials != nil { Button("清除此手机配对", role: .destructive) { disconnecting = true }.disabled(sync.busy) }
        Text("版本 " + (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—") + " (" + (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "—") + ")").font(.caption2).foregroundStyle(.secondary)
    }.padding() } .navigationTitle("DeskBox Mobile")
        .alert("清除此手机配对？", isPresented: $disconnecting) { Button("清除配对", role: .destructive) { sync.disconnect() }; Button("取消", role: .cancel) {} } message: { Text("离线数据和待上传内容会保留。需要彻底撤销设备访问时，请在电脑端撤销设备。") }
    } }
    private func panel(_ title:String,_ value:String)->some View { VStack(alignment:.leading){Text(title).font(.caption).foregroundStyle(.cyan);Text(value).font(.title3.bold()).frame(maxWidth:.infinity,alignment:.leading)}.padding().background(Color(red:0.06,green:0.11,blue:0.18),in:RoundedRectangle(cornerRadius:14)) }
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
                Text("待上传 \(store.pending.count) 条 · 编辑后保存在本机，回首页同步").font(.caption).foregroundStyle(.secondary)
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

struct ProjectsView: View { @EnvironmentObject var store: OfflineStore; var body: some View { NavigationStack { List(store.projects){p in VStack(alignment:.leading){HStack{Text(p.name).font(.headline);Spacer();Text(p.progressApplicable == false ? "N/A" : "\(Int(p.progress))%")};if p.progressApplicable != false { ProgressView(value:p.progress,total:100).tint(.cyan) };Text("\(p.customer) · \(p.equipment)").font(.caption).foregroundStyle(.secondary)}}.navigationTitle("Projects") } } }

struct IncidentView: View {
    @EnvironmentObject var store: OfflineStore; @State private var description=""; @State private var severity="S3"
    var body: some View { NavigationStack { Form { Picker("Severity",selection:$severity){ForEach(["S1","S2","S3","S4"],id:\.self){Text($0)}}.pickerStyle(.segmented);TextField("What happened?",text:$description,axis:.vertical);Button("SAVE OFFLINE"){guard !description.isEmpty else{return};var x=Incident();x.description=description;x.severity=severity;store.incidents.append(x);store.queue("incident",id:x.id,value:x);description=""};Section("Recent"){ForEach(store.incidents){x in VStack(alignment:.leading){Text(x.severity+" · "+x.description);Text(x.status.uppercased()).font(.caption).foregroundStyle(.secondary)}}} }.navigationTitle("Incident") } }
}

struct MobileAIView: View { var body: some View { NavigationStack { ContentUnavailableView("AI Relay Pending",systemImage:"sparkles",description:Text("Windows AI&SI relay is intentionally disabled until an authenticated streaming endpoint is implemented." )).navigationTitle("AI&SI") } } }
