import SwiftUI

struct SyncConflictView: View {
    @EnvironmentObject var store: OfflineStore
    @EnvironmentObject var sync: SyncClient
    @Environment(\.dismiss) private var dismiss
    @State private var chosen: MobileConflict?
    @State private var keepPhone = false
    @State private var confirm = false
    @State private var message = ""
    var body: some View {
        NavigationStack {
            List {
                if !message.isEmpty { Section { Text(message).foregroundStyle(.orange) } }
                if store.conflicts.isEmpty { ContentUnavailableView("没有待处理冲突", systemImage: "checkmark.shield", description: Text("同步中的未上传内容仍会保留在本机。")) }
                ForEach(store.conflicts) { conflict in
                    Section(conflict.local.entityType == "incident" ? "现场事件冲突" : "任务冲突") {
                        Text("记录 " + conflict.local.id).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        VStack(alignment: .leading, spacing: 8) {
                            Text("手机版本 · v\(conflict.local.version)").font(.headline).foregroundStyle(.cyan)
                            Text(detail(conflict.local)).textSelection(.enabled)
                        }
                        VStack(alignment: .leading, spacing: 8) {
                            Text("电脑版本" + (conflict.remote.map { " · v\($0.version)" } ?? "")).font(.headline)
                            Text(conflict.remote.map(detail) ?? "等待拉取电脑版本，请先同步刷新").textSelection(.enabled)
                        }
                        if conflict.remote != nil {
                            Button("采用电脑版本") { chosen = conflict; keepPhone = false; confirm = true }
                            Button("保留手机版本并重新提交") { chosen = conflict; keepPhone = true; confirm = true }
                        }
                    }
                }
            }.navigationTitle("同步冲突")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) { Button("刷新") { sync.sync(store: store) }.disabled(sync.busy) }
            }
            .alert(keepPhone ? "按最新电脑版本重新提交手机内容？" : "采用电脑内容并放弃这条手机修改？", isPresented: $confirm) {
                Button("确认", role: keepPhone ? nil : .destructive) {
                    guard let chosen else { return }
                    if let error = store.resolveConflict(chosen, keepPhone: keepPhone) { message = error }
                    else { message = keepPhone ? "已保留手机内容，等待同步引擎确认" : "已采用电脑版本"; sync.automaticSync(store: store, force: true) }
                }
                Button("取消", role: .cancel) {}
            } message: { Text("选择前会再次检查版本；版本发生变化时不会覆盖现有修改。") }
        }
    }
    private func detail(_ record: SyncRecord) -> String {
        if record.deleted { return "此版本已删除该记录" }
        let data = Data(record.json.utf8)
        if record.entityType == "task", let task = try? JSONDecoder().decode(MobileTask.self, from: data) { return [task.title, "状态：" + (task.status == "done" ? "已完成" : "未完成"), "截止：" + task.due, "备注：" + task.notes].joined(separator: "\n") }
        if record.entityType == "incident", let item = try? JSONDecoder().decode(Incident.self, from: data) { return [item.description, "设备：" + item.equipment, "状态：" + item.stateLabel, "负责人：" + item.owner, "调查：" + item.cause, "措施：" + item.solution].joined(separator: "\n") }
        return "无法解析此版本，内容仍保留；请在电脑端处理。"
    }
}

