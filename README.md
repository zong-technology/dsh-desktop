# DSH Desktop 🖥️

包装 **DeepSeek Harness Web GUI**（`http://127.0.0.1:3080`）的 Windows 桌面客户端，内置**插件系统**、**上下文记忆**与**动态壁纸**，支持一键打包发布。

## ✨ 功能

| 功能 | 说明 |
|---|---|
| 🪟 桌面壳 | Electron 包装 DSH Web GUI（webview 内嵌，无需切窗口），左侧功能边栏 + 自定义标题栏（主题化渐变控制按钮），DSH 未启动时显示离线提示页，托盘常驻 |
| 🧩 插件系统 | 从 **GitHub 仓库**（`owner/repo[:子目录]` / `owner/repo@tag`，下载失败自动走国内镜像）、**zip 直链**、**本地目录**安装插件，带**安装进度流程视图**（解析→下载→解压→清单→兼容→复制→测试） |
| 🛡️ 安全协议 | **每次安装前**自动检查兼容性（OS/架构/Electron/DSH/Node 版本）→ **安装后自动运行插件测试** → 测试通过才启用；**任何一步失败自动回滚删除**，零残留 |
| ⭐ 推荐中心 | 内置推荐插件（GitHub 官方 Markdown 导出 / Hello 示例）与 Skill（翻译/代码审查/总结/日报/搜索引导…），一键安装或开关 |
| 🧠 上下文记忆 | 只读监听 DSH 对话；达到阈值（默认 70%）时自动生成**结构化完整交接摘要**（目标/待办/结论/最近内容/关键词），写入 `memory/HANDOFF.md`；支持 DeepSeek LLM 总结；**默认自动注入**新会话对话框，无缝衔接上下文 |
| 🎨 动态壁纸 | **两种模式**：①**客户端背景（默认）**——视频/网页壁纸显示在 DSH 客户端窗口内，可一键预览；②**系统桌面**——挂载到桌面图标之下（Wallpaper Engine 风格）。支持**目录自动轮换**（视频+图片，可调间隔） |
| 📦 打包 | `npm run dist` 产出 NSIS 安装包 + 便携版 exe |

## 🚀 快速开始

```bash
npm install
npm run make:icon   # 生成图标（开发期）
npm start           # 启动（需先运行 dsh web）
```

> 首次使用前请确认 DSH Web GUI 已启动：`dsh web`（默认 `http://127.0.0.1:3080`）。

## ✅ 测试

```bash
npm test                     # 核心测试：兼容性检查 / 插件安装回滚 / 记忆总结 / WorkerW 定位（57 项）
npm run test:wallpaper       # 动态壁纸真实挂载冒烟测试（Electron）
```

安全协议由测试强制保障：`test/run-tests.js` 中的 T3 覆盖「测试失败 → 自动回滚删除」「兼容性不符 → 拒绝」等场景。

## 📦 打包发布

```bash
npm run dist                 # 产出 dist/ 下的 Setup exe 与 portable exe
```

发布到 GitHub：将仓库推送到 GitHub 后，`registry/plugins.json` 可通过 raw URL 云端更新（客户端自动拉取，失败回退本地）。

## 🧩 插件开发

一个插件就是一个目录，包含 `manifest.json`（必需）+ 可选 `main.js` / `test.js`：

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "kind": "plugin",
  "description": "……",
  "main": "main.js",
  "test": "test.js",
  "compat": { "os": ["win32"], "arch": ["x64"], "electron": ">=28", "dsh": "*" }
}
```

- **`main.js`**：在 Electron 主进程运行，可导出 `activate(ctx)` / `deactivate(ctx)` / `test()`。
  `ctx` 提供 `mainWindow` / `settingsWindow` / `wallpaper` / `memory` / `log` / `registerIpc(channel, fn)` / `addTrayItem(label, click)` / `removeTrayItem(key)`。
- **`test.js`**：由插件管理器用 Node 运行，**退出码 0 = 测试通过**；环境变量 `PLUGIN_DIR` / `PLUGIN_ID` / `DSH_DESKTOP_VERSION`。
- **`compat`**：版本范围语法与 npm semver 子集一致（`>=28 <34`、`^1.2.3`、`~1.2.3`、`1.2.x`、`||`）。

安装方式（设置 → 插件 → 安装插件）：

```
owner/repo             # GitHub 默认分支 zip
owner/repo@tag         # GitHub tag zip
owner/repo@latest      # GitHub 最新 release
https://…/plugin.zip   # 任意 zip 直链
local:C:\path\to\dir   # 本地目录
```

> ⚠️ 插件在主进程运行、拥有完整 Node 权限，请只安装可信来源的插件。

## 🧠 Skill

Skill 是纯提示词数据（`kind: "skill"`，`prompt` 字段），开关后可在「推荐」页一键**复制提示词**，粘贴到 DSH 对话框使用，不执行任何代码。

## 📁 数据目录

`%APPDATA%/dsh-desktop/`：

```
plugins/       已安装插件
memory/        交接摘要 (handoffs/*.json + HANDOFF.md)
settings.json  应用设置（插件开关、壁纸配置）
memory.json    记忆设置
```

## 🔧 常见问题

- **主窗口显示「DSH Web GUI 未运行」**：确认 `dsh web` 已启动；可在设置 → 关于 → 重新加载 DSH 页面。
- **壁纸开关是灰的**：先到「推荐」页启用内置 wallpaper-plugin。
- **交接摘要怎么用**：记忆页点「注入到 DSH 对话框」（或复制后粘贴到新会话开头），模型即可恢复上下文。
