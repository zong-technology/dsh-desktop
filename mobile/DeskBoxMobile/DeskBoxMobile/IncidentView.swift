import SwiftUI

struct IncidentView: View {
    @EnvironmentObject var store: OfflineStore
    @State private var query = ""
    @State private var state = "all"
    @State private var editing: Incident?
    private var visible: [Incident] {
        store.incidents.filter { item in
            (state == "all" || item.status == state) && (query.isEmpty || [item.description, item.equipment, item.owner, item.cause, item.solution, projectName(item.projectId)].joined(separator: " ").localizedCaseInsensitiveContains(query))
        }.sorted { $0.updatedAt > $1.updatedAt }
    }
    private func projectName(_ id: String) -> String { store.projects.first { $0.id == id }?.name ?? (id.isEmpty ? "未关联项目" : id) }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("处理状态", selection: $state) {
                        Text("全部状态").tag("all")
                        ForEach(Incident.states, id: \.self) { value in Text(Incident(status: value).stateLabel).tag(value) }
                    }
                    Text("\(store.incidents.count)项现场事件 · 待上传\(store.pending.filter { $0.entityType == "incident" }.count)项").font(.caption).foregroundStyle(.secondary)
                }
                Section("调查与处理记录") {
                    if visible.isEmpty { ContentUnavailableView("暂无匹配事件", systemImage: "checkmark.shield", description: Text("记录现场现象、设备位号、根因和措施，并与电脑同步。")) }
                    ForEach(visible) { item in
                        Button { editing = item } label: {
                            VStack(alignment: .leading, spacing: 8) {
                                HStack { Label(item.severity, systemImage: "exclamationmark.triangle.fill").foregroundStyle(item.severity == "S1" ? .red : .orange); Spacer(); Text(item.stateLabel).foregroundStyle(.cyan) }.font(.caption.bold())
                                Text(item.description).foregroundStyle(.primary).lineLimit(3)
                                Text(projectName(item.projectId) + (item.equipment.isEmpty ? "" : " · " + item.equipment)).font(.caption).foregroundStyle(.secondary)
                                HStack { Text(item.owner.isEmpty ? "未指定负责人" : item.owner); Spacer(); Text(Date(timeIntervalSince1970: Double(item.updatedAt) / 1000), style: .date) }.font(.caption).foregroundStyle(.secondary)
                            }.padding(.vertical, 6)
                        }.buttonStyle(.plain)
                    }
                }
            }.navigationTitle("现场事件")
            .searchable(text: $query, prompt: "搜索项目、设备、现象或负责人")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { editing = Incident() } label: { Label("新建事件", systemImage: "plus") } } }
            .sheet(item: $editing) { item in IncidentEditor(incident: item, isNew: !store.incidents.contains(where: { $0.id == item.id })) }
        }
    }
}

struct IncidentEditor: View {
    @EnvironmentObject var store: OfflineStore
    @Environment(\.dismiss) private var dismiss
    @State private var incident: Incident
    @State private var error = ""
    @State private var expectedUpdatedAt: Int64?
    init(incident: Incident, isNew: Bool = false) { _incident = State(initialValue: incident); _expectedUpdatedAt = State(initialValue: isNew ? nil : incident.updatedAt) }
    var body: some View {
        NavigationStack {
            Form {
                Section("工程上下文") {
                    Picker("关联项目", selection: $incident.projectId) {
                        Text("未关联项目").tag("")
                        if !incident.projectId.isEmpty && !store.projects.contains(where: { $0.id == incident.projectId }) { Text("原项目（待同步）").tag(incident.projectId) }
                        ForEach(store.projects) { Text($0.name).tag($0.id) }
                    }
                    TextField("设备名称 / 位号，例如 PT-101", text: $incident.equipment)
                    TextField("负责人", text: $incident.owner)
                    DatePicker("发生时间", selection: Binding(get: { Date(timeIntervalSince1970: Double(incident.occurredAt) / 1000) }, set: { incident.occurredAt = Int64($0.timeIntervalSince1970 * 1000) }))
                }
                Section("现场调查") {
                    Picker("严重程度", selection: $incident.severity) { ForEach(["S1", "S2", "S3", "S4"], id: \.self) { Text($0) } }
                    Picker("处理状态", selection: $incident.status) { ForEach(Incident.states, id: \.self) { value in Text(Incident(status: value).stateLabel).tag(value) } }
                    TextField("现象描述", text: $incident.description, axis: .vertical).lineLimit(4...10)
                    TextField("调查结果 / 根因", text: $incident.cause, axis: .vertical).lineLimit(3...8)
                    TextField("处理措施（解决或关闭前必填）", text: $incident.solution, axis: .vertical).lineLimit(3...8)
                }
                if !error.isEmpty { Section { Text(error).foregroundStyle(.red) } }
                Section { Text("保存在本机并自动同步。编辑期间收到另一端更新时，会阻止覆盖并提示重新查看。").font(.caption).foregroundStyle(.secondary) }
            }.navigationTitle("事件详情")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("保存") {
                    if let message = store.updateIncident(incident, expectedUpdatedAt: expectedUpdatedAt) { error = message } else { dismiss() }
                } }
            }
        }
    }
}

