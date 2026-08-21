'use strict';
/**
 * main.js — DSH Desktop 主进程
 *
 * 职责：
 *   - 包装 DSH Web GUI (默认 http://127.0.0.1:3080)，DSH 未启动时显示离线页
 *   - 插件系统：安装/卸载/开关/运行时激活（安全协议：兼容检查 + 测试 + 失败回滚）
 *   - 上下文记忆：注入监听脚本 → 接近上限自动总结 → 交接下一个会话
 *   - 动态壁纸引擎（视频/网页）
 *   - 内置插件：wallpaper-plugin（壁纸）、memory-plugin（记忆）可独立开关
 *   - 托盘 + 设置窗口
 */
const { app, BrowserWindow, WebContentsView, Tray, Menu, ipcMain, shell, clipboard, dialog, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_ROOT = app.getAppPath();
const SRC_DIR = __dirname;
const UI_DIR = path.join(APP_ROOT, 'ui');
const REGISTRY_LOCAL = path.join(APP_ROOT, 'registry', 'plugins.json');
const EXAMPLE_PLUGINS = path.join(APP_ROOT, 'example-plugins');

const PluginManager = require('./plugin-manager');
const MemoryService = require('./memory');
const WallpaperEngine = require('./wallpaper');
const Registry = require('./registry');
const QQBridge = require('./qq-bridge');
const { watcherScript, injectHandoffScript } = require('./inject-watcher');

// —— 命令行开关：避免隐藏壁纸窗口被 OCR/遮挡逻辑挂起 ——
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// —— 单实例锁 ——
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

const DEFAULTS = {
  dshUrl: process.env.DSH_URL || 'http://127.0.0.1:3080',
  registryUrl: 'https://raw.githubusercontent.com/zong-technology/dsh-desktop/main/registry/plugins.json',
  deepseekApiKey: '',
};

let mainWindow = null;
let settingsWindow = null;
let guestContents = null;   // 内嵌 DSH webview 的 webContents
let dshConnected = false;
let tray = null;
let pluginManager = null;
let memoryService = null;
let wallpaperEngine = null;
let registry = null;
let qqBridge = null;
let appSettings = null;
let activePlugins = new Map(); // id -> { mod, deactivate }
let wpCssKeys = []; // 已注入的壁纸透明化 CSS key（guest 页面内）
let wpTextMode = 'dark'; // 当前 DSH 文字颜色模式：'dark'=深色文字(亮壁纸) | 'light'=浅色文字(暗壁纸)

function userDataFile(name) {
  return path.join(app.getPath('userData'), name);
}

function loadAppSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(userDataFile('settings.json'), 'utf8'));
    // 旧版占位符 registryUrl（dsh-desktop/dsh-desktop）→ 用新默认
    if (parsed.registryUrl && /\/dsh-desktop\/dsh-desktop\//.test(parsed.registryUrl)) delete parsed.registryUrl;
    appSettings = { ...DEFAULTS, ...parsed };
  } catch {
    appSettings = { ...DEFAULTS };
  }
  appSettings.plugins = appSettings.plugins || {};
  // 清理历史遗留的 "undefined" 开关
  if (appSettings.plugins['undefined']) delete appSettings.plugins['undefined'];
  appSettings.wallpaper = appSettings.wallpaper || { type: 'off', source: '', enabled: false, mode: 'window', opacity: 100 };
  if (!appSettings.wallpaper.mode) appSettings.wallpaper.mode = 'window';
  // opacity = 壁纸不透明度(0-100)，默认 100；旧版语义(遮罩深浅55)直接视为新语义值，用户可自行调整
  if (appSettings.wallpaper.opacity === undefined) {
    appSettings.wallpaper.opacity = 100;
  }
  // QQ 同步桥默认设置
  appSettings.qq = appSettings.qq || { enabled: false, apiUrl: 'http://127.0.0.1:3000', listenPort: 18777, allowedUsers: '', prefix: '' };
  return appSettings;
}

function saveAppSettings() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(userDataFile('settings.json'), JSON.stringify(appSettings, null, 2), 'utf8');
}

function pluginEnabled(id) {
  loadAppSettings();
  return !!appSettings.plugins[id]?.enabled;
}

// ================= Skill 同步（写入 DSH skills 目录） =================
// DSH 从 ~/.dsh/skills/<id>/SKILL.md 加载技能（YAML frontmatter + body）。
// 启用的 skill 落盘 → DSH 实际生效；关闭的删除。

const DSH_SKILLS_DIR = () => path.join(app.getPath('home'), '.dsh', 'skills');

function skillMarkdown(s) {
  return `---
name: ${s.name || s.id}
description: ${(s.description || '').split('\n')[0]}
---
${s.prompt || s.description || ''}
`;
}

async function syncSkillsToDsh() {
  try {
    const r = await registry.getRecommended();
    const skills = (r.items || []).filter((i) => i.kind === 'skill' && i.id);
    if (!skills.length) return;
    const root = DSH_SKILLS_DIR();
    fs.mkdirSync(root, { recursive: true });
    let on = 0;
    for (const s of skills) {
      const enabled = !!appSettings.plugins[s.id]?.enabled;
      const dir = path.join(root, s.id);
      if (enabled) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMarkdown(s), 'utf8');
        on++;
      } else {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    console.log(`[skill] 同步完成: 启用 ${on} / 共 ${skills.length} 个 Skill → ${root}`);
  } catch (e) {
    console.warn('[skill] 同步失败: ' + e.message);
  }
}

// ================= 窗口 =================

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 620,
    icon: path.join(UI_DIR, 'assets', 'icon.png'),
    backgroundColor: '#0f1115',
    show: false,
    frame: false, // 无边框：自定义标题栏（边框跟随壁纸主题 + 彩色控制按钮）
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      preload: path.join(SRC_DIR, 'preload.js'),
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.on('did-finish-load', () => pushDshStatus());
  mainWindow.on('maximize', () => pushWinState());
  mainWindow.on('unmaximize', () => pushWinState());

  // —— 内嵌 DSH 视图（webview guest）——
  mainWindow.webContents.on('did-attach-webview', (_e, guest) => {
    guestContents = guest;
    guest.on('did-finish-load', () => {
      const url = guest.getURL();
      if (url.startsWith('http')) setDshStatus(true);
      wpCssKeys = []; // 页面重载后旧 CSS key 失效，需重新注入
      maybeInjectWatcher();
      applyGuestWallpaper();
    });
    guest.on('did-navigate', () => {
      const url = guest.getURL();
      if (url.startsWith('http')) setDshStatus(true);
      wpCssKeys = [];
      maybeInjectWatcher();
      applyGuestWallpaper();
    });
    guest.on('did-fail-load', (_ev, code, desc, validatedURL, isMainFrame) => {
      if (isMainFrame) setDshStatus(false);
    });
    // 首次加载 DSH
    if (!guest.getURL()) {
      loadDsh();
    }
  });

  mainWindow.webContents.loadFile(path.join(UI_DIR, 'shell.html'));
  return mainWindow;
}

function setDshStatus(connected) {
  const changed = dshConnected !== connected;
  dshConnected = connected;
  if (changed) pushDshStatus();
}

function pushDshStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dsh:status', { connected: dshConnected, url: appSettings.dshUrl });
  }
}

function pushWinState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('window:state', { maximized: mainWindow.isMaximized() });
  }
}

/** 扫描壁纸目录，返回支持的视频/图片文件（file:// URL 列表） */
const WALLPAPER_VIDEO_EXT = ['.mp4', '.webm', '.mov', '.mkv', '.avi', '.gif'];
const WALLPAPER_IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'];

function scanWallpaperDir(dir) {
  const videos = [];
  const images = [];
  if (!fs.existsSync(dir)) return { videos, images, dir };
  for (const name of fs.readdirSync(dir)) {
    const ext = path.extname(name).toLowerCase();
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;
    if (WALLPAPER_VIDEO_EXT.includes(ext)) videos.push('file:///' + full.replace(/\\/g, '/'));
    else if (WALLPAPER_IMAGE_EXT.includes(ext)) images.push('file:///' + full.replace(/\\/g, '/'));
  }
  videos.sort();
  images.sort();
  return { videos, images, dir };
}

async function loadDsh() {
  if (!guestContents) return;
  try {
    await guestContents.loadURL(appSettings.dshUrl);
  } catch (e) {
    // did-fail-load 会接管
  }
}

function maybeInjectWatcher() {
  if (!pluginEnabled('memory-plugin')) return;
  if (!guestContents || guestContents.isDestroyed()) return;
  const url = guestContents.getURL();
  if (!url.startsWith('http')) return; // 只在 DSH 页面注入
  guestContents
    .executeJavaScript(watcherScript, true)
    .catch(() => { /* 页面可能尚未就绪，忽略 */ });
}

/**
 * 会话背景壁纸：让 DSH 会话界面透出壁纸（聊天软件背景效果）。
 * 做法（规避页面 CSP 对内联 <style> 的限制）：
 *  用 inline style（setProperty + important）把 html/body 背景改为透明，
 *  页面透明处直接透出 webview 元素（默认透明背景）之后的壁纸层；
 *  关闭时还原记录的原始背景色。会话框（webview）始终保留。
 */
/**
 * 会话背景壁纸：让整个 DSH 会话界面（含聊天框）透出壁纸（聊天软件背景效果）。
 * 采用 insertCSS（CSS 引擎注入，不执行 JS——DSH 页面执行复杂 JS 脚本会失败）：
 *  1. 全页面透明：html/body 及所有容器背景 → 透明（壁纸贯穿整个会话界面，
 *     包括聊天框/会话列表/内容区），文字与边框不受影响。
 *  2. 输入区保留半透明白底，保证输入框边界可见、可读。
 *  3. 可读性由客户端壁纸层的「暗色遮罩」保证（透明度可调，wallpaper.opacity）。
 *  关闭时 removeInsertedCSS 恢复 DSH 原本白色界面。
 */
function wallpaperCss() {
  return `
    html, body, #root { background: transparent !important; }
    * { background: transparent !important; }
    input, textarea, button, [contenteditable="true"], [role="textbox"] {
      background: rgba(255, 255, 255, 0.14) !important;
    }
  `;
}

/**
 * 文字颜色自适应 CSS：根据壁纸平均亮度切换文字颜色（让文字在壁纸上清晰可读）。
 * 只重映射 DSH 官方 label/brand token（文字色），不强制全局 color（保留代码高亮等）。
 * mode 'light' = 壁纸偏暗 → 浅色文字；mode 'dark' = 壁纸偏亮 → 深色文字。
 */
function wallpaperTextCss(mode) {
  if (mode === 'light') {
    return `* {
      --dsw-alias-label-primary: #f2f4f8 !important;
      --dsw-alias-label-secondary: #c9cfd9 !important;
      --dsw-alias-label-tertiary: #9aa3b2 !important;
      --dsw-alias-label-dimmed: #8f97a6 !important;
      --dsw-alias-label-caption: #b9c1cc !important;
      --dsw-alias-label-primary-inverted: #10141c !important;
      --dsw-alias-brand-text: #f2f4f8 !important;
    }`;
  }
  return `* {
    --dsw-alias-label-primary: #1b2130 !important;
    --dsw-alias-label-secondary: #4a5264 !important;
    --dsw-alias-label-tertiary: #6b7488 !important;
    --dsw-alias-label-dimmed: #8b93a3 !important;
    --dsw-alias-label-caption: #55607a !important;
    --dsw-alias-label-primary-inverted: #f2f4f8 !important;
    --dsw-alias-brand-text: #1b2130 !important;
  }`;
}

function applyGuestWallpaper() {
  if (!guestContents || guestContents.isDestroyed()) return;
  const url = guestContents.getURL();
  if (!url.startsWith('http')) return;
  const w = appSettings.wallpaper;
  const on =
    pluginEnabled('wallpaper-plugin') &&
    !!w.enabled &&
    w.mode !== 'desktop' &&
    w.type !== 'off' &&
    !!w.source;
  if (on) {
    if (wpCssKeys.length > 0) return; // 已注入（透明 CSS + 文字 CSS）
    // 透明 CSS
    guestContents
      .insertCSS(wallpaperCss())
      .then((key) => wpCssKeys.push(key))
      .catch(() => {});
    // 文字颜色自适应 CSS（当前模式）
    guestContents
      .insertCSS(wallpaperTextCss(wpTextMode))
      .then((key) => wpCssKeys.push(key))
      .catch(() => {});
  } else {
    if (wpCssKeys.length === 0) return;
    const keys = wpCssKeys;
    wpCssKeys = [];
    Promise.all(keys.map((k) => guestContents.removeInsertedCSS(k).catch(() => {}))).catch(() => {});
  }
}

/** 根据壁纸亮度切换文字颜色（shell 检测亮度后调用） */
function setWallpaperTextMode(dark) {
  // dark=true 表示壁纸偏亮（近白，sum/n>210）→ 用深色文字；否则用浅色文字
  const mode = dark ? 'dark' : 'light';
  if (mode === wpTextMode) return;
  wpTextMode = mode;
  if (!guestContents || guestContents.isDestroyed() || wpCssKeys.length === 0) return;
  // 移除旧文字 CSS（最后一个 key）并注入新模式
  const oldKey = wpCssKeys.pop();
  guestContents.removeInsertedCSS(oldKey).catch(() => {});
  guestContents
    .insertCSS(wallpaperTextCss(mode))
    .then((key) => wpCssKeys.push(key))
    .catch(() => {});
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return settingsWindow;
  }
  settingsWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 820,
    minHeight: 600,
    title: 'DSH Desktop · 设置',
    icon: path.join(UI_DIR, 'assets', 'icon.png'),
    // 独立窗口（不用 parent）：避免任何模态/禁用主窗口行为（功能窗口打不开的修复）
    modal: false,
    show: false, // 先隐藏，加载完成再显示（避免白屏）
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(SRC_DIR, 'preload.js'),
    },
  });
  settingsWindow.loadFile(path.join(UI_DIR, 'index.html'));
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
  return settingsWindow;
}

// ================= 托盘 =================

function rebuildTray() {
  if (!tray) {
    const icon = nativeImage.createFromPath(path.join(UI_DIR, 'assets', 'icon-32.png'));
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    tray.setToolTip('DSH Desktop');
    tray.on('click', () => {
      if (mainWindow) {
        mainWindow.isMinimized() ? mainWindow.restore() : mainWindow.focus();
      }
    });
  }
  const items = [
    { label: '打开主窗口', click: () => mainWindow && mainWindow.show() },
    { label: '设置', click: () => createSettingsWindow() },
    { type: 'separator' },
  ];
  // 插件贡献的托盘项
  for (const [, entry] of activePlugins) {
    if (Array.isArray(entry.trayItems)) {
      for (const it of entry.trayItems) {
        items.push({ label: it.label, click: () => it.click() });
      }
    }
  }
  items.push(
    { type: 'separator' },
    {
      label: '生成交接摘要',
      click: async () => {
        const r = await memoryService.summarizeNow('manual');
        if (r.ok) {
          new Notification({ title: 'DSH Desktop', body: '已生成交接摘要，可在设置 → 记忆 中查看/复制' }).show();
        } else {
          new Notification({ title: 'DSH Desktop', body: `交接摘要生成失败: ${r.error}` }).show();
        }
      },
    },
    {
      label: '壁纸: ' + (wallpaperEngine.isActive() ? '关闭' : '开启(视频)'),
      click: () => (wallpaperEngine.isActive() ? wallpaperEngine.stop() : wallpaperEngine.startVideo(appSettings.wallpaper.source)),
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ================= 插件运行时 =================

function buildPluginCtx() {
  return {
    app,
    get mainWindow() { return mainWindow; },
    get settingsWindow() { return settingsWindow; },
    tray,
    wallpaper: wallpaperEngine,
    memory: memoryService,
    log: console,
    appVersion: app.getVersion(),
    registerIpc: (channel, handler) => ipcMain.handle(channel, handler),
    notify: (msg) => {
      try {
        const { Notification } = require('electron');
        new Notification({ title: 'DSH Desktop', body: String(msg) }).show();
      } catch (e) { /* ignore */ }
    },
    addTrayItem: (label, clickFn) => {
      // 延长生命周期：存到 map 里由 rebuildTray 读取
      const key = `dyn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      dynTrayItems.set(key, { label, click: clickFn });
      rebuildTray();
      return key;
    },
    removeTrayItem: (key) => {
      dynTrayItems.delete(key);
      rebuildTray();
    },
  };
}

const dynTrayItems = new Map();

async function activatePlugins() {
  for (const p of pluginManager.list()) {
    if (!p.enabled || !p.manifest.main || p.manifest.builtin) continue;
    try {
      const mod = require(p.path + '\\' + p.manifest.main);
      const ctx = buildPluginCtx();
      const entry = { mod, ctx, trayItems: [] };
      if (typeof mod.activate === 'function') {
        mod.activate(ctx);
      }
      if (mod.trayItems) {
        for (const it of mod.trayItems) {
          entry.trayItems.push({ label: it.label, click: it.click });
        }
      }
      activePlugins.set(p.id, entry);
      console.log(`[plugin] 已激活 ${p.id}@${p.manifest.version}`);
    } catch (e) {
      console.warn(`[plugin] ${p.id} 激活失败: ${e.message}`);
    }
  }
  rebuildTray();
}

function deactivatePlugins() {
  for (const [id, entry] of activePlugins) {
    try {
      entry.mod.deactivate?.(entry.ctx);
    } catch (e) {
      console.warn(`[plugin] ${id} 停用失败: ${e.message}`);
    }
  }
  activePlugins.clear();
}

// ================= 内置插件行为 =================

/**
 * 应用壁纸设置。
 * mode 'window'（默认）→ 客户端窗口背景，由 shell 页面渲染，无需操作系统桌面；
 * mode 'desktop' → Wallpaper Engine 风格，挂载到 Windows 系统桌面图标之下。
 */
async function applyWallpaperPlugin() {
  const w = appSettings.wallpaper;
  const enabled = pluginEnabled('wallpaper-plugin') && !!w.enabled;
  if (!enabled) {
    await wallpaperEngine.stop();
    broadcast('wallpaper:changed', {});
    applyGuestWallpaper();
    return;
  }
  if (w.mode === 'desktop') {
    if (w.type === 'video' && w.source) {
      try {
        await wallpaperEngine.startVideo(w.source);
      } catch (e) {
        console.warn(`[wallpaper] 桌面壁纸启动失败: ${e.message}`);
      }
    } else if (w.type === 'web' && w.source) {
      try {
        await wallpaperEngine.startWeb(w.source);
      } catch (e) {
        console.warn(`[wallpaper] 桌面壁纸启动失败: ${e.message}`);
      }
    } else if (w.type === 'dir' && w.source) {
      try {
        const scan = scanWallpaperDir(w.source);
        await wallpaperEngine.startDir(scan, w.interval || 60);
      } catch (e) {
        console.warn(`[wallpaper] 桌面壁纸目录启动失败: ${e.message}`);
      }
    }
  } else {
    await wallpaperEngine.stop();
  }
  broadcast('wallpaper:changed', { settings: w, enabled });
  applyGuestWallpaper();
}

// ================= IPC =================

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    dshVersion: process.env.DSH_VERSION || 'unknown',
    dshUrl: appSettings.dshUrl,
    os: process.platform,
    arch: process.arch,
    pluginsDir: pluginManager.pluginsDir,
    memoryDir: memoryService.memoryDir,
    wallpaperSupported: wallpaperEngine.supported,
    builtins: { wallpaperPlugin: pluginEnabled('wallpaper-plugin'), memoryPlugin: pluginEnabled('memory-plugin') },
  }));

  ipcMain.handle('plugins:list', () => pluginManager.list());
  ipcMain.handle('plugins:install', async (_e, spec) => {
    const r = await pluginManager.installFromSpec(String(spec || '').trim(), {
      onProgress: (p) => broadcast('plugin:install-progress', p),
    });
    if (r.ok) {
      // 尝试热激活（main 插件需重启后完全生效，这里只提示）
      rebuildTray();
      if (r.manifest.main && !r.manifest.builtin) {
        try {
          const mod = require(r.path + '\\' + r.manifest.main);
          if (typeof mod.activate === 'function') mod.activate(buildPluginCtx());
        } catch (e) {
          console.warn(`[plugin] 热激活失败（重启后生效）: ${e.message}`);
        }
      }
    }
    return r;
  });
  ipcMain.handle('plugins:uninstall', async (_e, id) => {
    const r = await pluginManager.uninstall(String(id));
    if (r.ok) {
      const entry = activePlugins.get(id);
      if (entry) {
        try { entry.mod.deactivate?.(entry.ctx); } catch { /* ignore */ }
        activePlugins.delete(id);
      }
      rebuildTray();
    }
    return r;
  });
  ipcMain.handle('plugins:toggle', async (_e, id, enabled) => {
    id = String(id || '').trim();
    if (!id || id === 'undefined') return { ok: false, error: '缺少插件 ID' };
    const r = await pluginManager.toggle(id, !!enabled);
    if (r.ok) {
      if (id === 'wallpaper-plugin') await applyWallpaperPlugin();
      if (id === 'memory-plugin') maybeInjectWatcher();
      // skill 开关 → 同步写入 DSH skills 目录（~/.dsh/skills/<id>/SKILL.md）
      await syncSkillsToDsh();
    }
    return r;
  });

  ipcMain.handle('qq:settings:get', () => appSettings.qq || {});
  ipcMain.handle('qq:settings:set', async (_e, patch) => {
    patch = patch || {};
    appSettings.qq = { ...(appSettings.qq || {}), ...patch };
    if (patch.allowedUsers !== undefined) appSettings.qq.allowedUsers = String(patch.allowedUsers || '').trim();
    if (patch.prefix !== undefined) appSettings.qq.prefix = String(patch.prefix || '').trim();
    saveAppSettings();
    if (qqBridge) qqBridge.sync();
    return appSettings.qq;
  });
  ipcMain.handle('qq:test', async () => {
    if (!qqBridge) return { ok: false, error: '桥接未初始化' };
    const r = await qqBridge.test();
    return r;
  });

  ipcMain.handle('registry:recommended', async () => {
    // 并行拉取：本地推荐 + GitHub 仓库市场 + GitHub 热门插件（避免串行卡顿）
    const [r, market, found] = await Promise.all([
      registry.getRecommended().catch(() => ({ items: [], source: 'local' })),
      registry.fetchGithubMarket().catch(() => []),
      registry.searchGithubPlugins().catch(() => []),
    ]);
    // 合并 GitHub 仓库市场（dsh-web-ui 官方生态包）
    try {
      if (market.length) {
        const ids = new Set((r.items || []).map((i) => i.id));
        r.items = [...(r.items || []), ...market.filter((m) => !ids.has(m.id))];
      }
    } catch (e) {
      // 市场拉取失败不影响本地
    }
    // 合并 GitHub 热门插件搜索（全部适配 DSH 的仓库，按 star 排序）
    try {
      if (found.length) {
        const ids = new Set((r.items || []).map((i) => i.id));
        r.items = [...(r.items || []), ...found.filter((m) => !ids.has(m.id))];
      }
    } catch (e) {
      // 搜索失败不影响本地
    }
    // 解析本地/仓库安装源为可安装 spec
    for (const item of r.items || []) {
      if (item.source?.local) {
        item.installSpec = 'local:' + path.join(APP_ROOT, item.source.local);
      } else if (item.source?.github) {
        item.installSpec = item.source.github;
      }
      // 合并开关状态（skill 等也存于 settings.plugins）
      if (item.id) item.enabledState = !!appSettings.plugins[item.id]?.enabled;
    }
    return r;
  });

  ipcMain.handle('memory:settings:get', () => memoryService.loadSettings());
  ipcMain.handle('memory:settings:set', async (_e, patch) => {
    patch = patch || {};
    if (typeof patch.enabled === 'boolean') {
      const enabled = patch.enabled;
      await memoryService.saveSettings({ enabled });
      if (!enabled) maybeInjectWatcherRemoval();
      else maybeInjectWatcher();
    }
    if (typeof patch.contextLimit === 'number') await memoryService.saveSettings({ contextLimit: patch.contextLimit });
    if (typeof patch.summarizeAt === 'number') await memoryService.saveSettings({ summarizeAt: patch.summarizeAt });
    if (typeof patch.deepseekApiKey === 'string') await memoryService.saveSettings({ deepseekApiKey: patch.deepseekApiKey });
    if (typeof patch.autoInjectHandoff === 'boolean') await memoryService.saveSettings({ autoInjectHandoff: patch.autoInjectHandoff });
    return memoryService.loadSettings();
  });
  ipcMain.on('memory:report', (_e, data) => {
    if (!pluginEnabled('memory-plugin')) return;
    if (!data || typeof data.text !== 'string') return;
    memoryService.report(data).then((r) => {
      if (r.summarized) {
        new Notification({ title: 'DSH Desktop · 上下文记忆', body: `对话接近上限（${Math.round(r.pct * 100)}%），已自动生成交接摘要` }).show();
        if (settingsWindow && !settingsWindow.isDestroyed()) {
          settingsWindow.webContents.send('memory:handoff-updated', r);
        }
      }
    });
  });
  ipcMain.handle('memory:summary', async (_e, mode) => memoryService.summarizeNow(mode === 'llm' ? 'llm' : 'manual'));
  ipcMain.handle('memory:import-from-page', async () => {
    // 把 DSH 页面当前会话文本导入记忆并立即生成交接摘要（可覆盖浏览器/历史会话）
    if (!guestContents || guestContents.isDestroyed() || !guestContents.getURL().startsWith('http')) {
      return { ok: false, error: 'DSH 页面未加载，无法导入' };
    }
    const data = await guestContents
      .executeJavaScript(
        `(function(){
          try {
            var t = document.body ? document.body.innerText : '';
            return { text: t.slice(-400000), title: document.title || '', url: location.href || '' };
          } catch(e) { return null; }
        })()`,
        true
      )
      .catch(() => null);
    if (!data || !data.text || data.text.trim().length < 50) {
      return { ok: false, error: '未能提取会话文本（请先在 DSH 中打开一个历史会话）' };
    }
    try {
      const f = path.join(userDataFile('memory'), `import-${Date.now()}.json`);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ ts: Date.now(), title: data.title, url: data.url, text: data.text, manual: true }, null, 2), 'utf8');
    } catch { /* 快照写入失败不阻塞总结 */ }
    await memoryService.report({ text: data.text, title: data.title, url: data.url, ts: Date.now() });
    const r = await memoryService.summarizeNow('import');
    if (!r.ok) return { ok: false, error: '总结失败' };
    return { ok: true, chars: data.text.length, title: data.title, handoff: r.handoff };
  });
  ipcMain.handle('memory:handoff', () => memoryService.getHandoff());
  ipcMain.handle('memory:conversations', () => memoryService.listConversations());
  ipcMain.handle('memory:inject-handoff', async () => {
    if (!guestContents || guestContents.isDestroyed()) return { ok: false, error: '主窗口未打开' };
    const handoff = await memoryService.getHandoff();
    if (!handoff) return { ok: false, error: '暂无交接摘要' };
    const ok = await guestContents
      .executeJavaScript(injectHandoffScript(handoff.summary), true)
      .catch(() => false);
    return { ok: !!ok, error: ok ? null : '未能注入（对话框可能不可用，请手动复制粘贴）' };
  });

  // —— 左侧边栏 ——
  ipcMain.handle('dsh:status', () => ({ connected: dshConnected, url: appSettings.dshUrl }));
  ipcMain.handle('settings:open', (_e, tab) => {
    const w = createSettingsWindow();
    if (typeof tab === 'string' && tab) {
      setTimeout(() => {
        if (w && !w.isDestroyed()) w.webContents.send('nav-to', tab);
      }, 300);
    }
    return { ok: true };
  });
  ipcMain.handle('app:quit', () => {
    app.quit();
    return { ok: true };
  });

  // —— 窗口控制（自定义标题栏）——
  ipcMain.handle('window:minimize', () => { mainWindow?.minimize(); return { ok: true }; });
  ipcMain.handle('window:maximize-toggle', () => {
    if (!mainWindow) return { ok: false };
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    return { ok: true, maximized: mainWindow.isMaximized() };
  });
  ipcMain.handle('window:close', () => { mainWindow?.close(); return { ok: true }; });
  ipcMain.handle('window:state', () => ({ maximized: !!mainWindow?.isMaximized() }));

  ipcMain.handle('wallpaper:state', () => ({
    active: pluginEnabled('wallpaper-plugin') && !!appSettings.wallpaper.enabled,
    supported: wallpaperEngine.supported,
    settings: appSettings.wallpaper,
  }));
  ipcMain.handle('wallpaper:start-video', async (_e, file) => {
    if (!pluginEnabled('wallpaper-plugin')) return { ok: false, error: '壁纸插件已关闭，请先在 推荐/插件 中启用' };
    const mode = (appSettings.wallpaper && appSettings.wallpaper.mode) || 'window';
    appSettings.wallpaper = { ...appSettings.wallpaper, type: 'video', source: String(file), enabled: true, mode };
    saveAppSettings();
    await applyWallpaperPlugin();
    return { ok: true };
  });
  ipcMain.handle('wallpaper:start-web', async (_e, url) => {
    if (!pluginEnabled('wallpaper-plugin')) return { ok: false, error: '壁纸插件已关闭，请先在 推荐/插件 中启用' };
    const mode = (appSettings.wallpaper && appSettings.wallpaper.mode) || 'window';
    appSettings.wallpaper = { ...appSettings.wallpaper, type: 'web', source: String(url), enabled: true, mode };
    saveAppSettings();
    await applyWallpaperPlugin();
    return { ok: true };
  });
  ipcMain.handle('wallpaper:start-dir', async (_e, dir) => {
    if (!pluginEnabled('wallpaper-plugin')) return { ok: false, error: '壁纸插件已关闭，请先在 推荐/插件 中启用' };
    dir = String(dir || '');
    const scan = scanWallpaperDir(dir);
    if (!scan.videos.length && !scan.images.length) {
      return { ok: false, error: `目录中没有支持的壁纸文件（视频: ${WALLPAPER_VIDEO_EXT.join(' ')}；图片: ${WALLPAPER_IMAGE_EXT.join(' ')}）` };
    }
    const mode = (appSettings.wallpaper && appSettings.wallpaper.mode) || 'window';
    const interval = (appSettings.wallpaper && appSettings.wallpaper.interval) || 60;
    appSettings.wallpaper = { ...appSettings.wallpaper, type: 'dir', source: dir, enabled: true, mode, interval };
    saveAppSettings();
    await applyWallpaperPlugin();
    return { ok: true, files: scan };
  });
  ipcMain.handle('wallpaper:files', (_e, dir) => scanWallpaperDir(String(dir || '')));
  ipcMain.handle('wallpaper:stop', async () => {
    appSettings.wallpaper = { ...appSettings.wallpaper, enabled: false };
    saveAppSettings();
    await applyWallpaperPlugin();
    return { ok: true };
  });
  ipcMain.handle('wallpaper:settings:get', () => appSettings.wallpaper);
  ipcMain.handle('wallpaper:brightness', (_e, { dark }) => {
    // shell 检测壁纸平均亮度 → 切换 DSH 文字颜色（亮壁纸深字/暗壁纸浅字）
    setWallpaperTextMode(!!dark);
    return { ok: true };
  });
  ipcMain.handle('wallpaper:settings:set', async (_e, patch) => {
    Object.assign(appSettings.wallpaper, patch || {});
    saveAppSettings();
    await applyWallpaperPlugin();
    return appSettings.wallpaper;
  });

  ipcMain.handle('dialog:pick-video', async () => {
    const r = await dialog.showOpenDialog(settingsWindow || mainWindow, {
      title: '选择视频壁纸',
      filters: [{ name: '视频', extensions: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'gif'] }],
      properties: ['openFile'],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:pick-dir', async () => {
    const r = await dialog.showOpenDialog(settingsWindow || mainWindow, {
      title: '选择壁纸目录（自动轮换）',
      properties: ['openDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('app:reload-dsh', async () => {
    await loadDsh();
    return { ok: true };
  });
  ipcMain.handle('app:open-external', (_e, url) => {
    if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url));
  });
  ipcMain.handle('app:copy', (_e, text) => {
    clipboard.writeText(String(text ?? ''));
    return { ok: true };
  });
  ipcMain.handle('settings:get', () => appSettings);
  ipcMain.handle('settings:set-registry-url', (_e, url) => {
    appSettings.registryUrl = String(url || '');
    saveAppSettings();
    registry.remoteUrl = appSettings.registryUrl;
    return appSettings.registryUrl;
  });
  // 侧边栏折叠状态（shell 页面持久化）
  ipcMain.handle('ui:settings:get', () => ({
    sidebarCollapsed: !!(appSettings.ui && appSettings.ui.sidebarCollapsed),
  }));
  ipcMain.handle('ui:settings:set', (_e, patch) => {
    appSettings.ui = appSettings.ui || {};
    if (typeof patch?.sidebarCollapsed === 'boolean') appSettings.ui.sidebarCollapsed = patch.sidebarCollapsed;
    saveAppSettings();
    return appSettings.ui;
  });

  // ===== MCP 管理 =====
  ipcMain.handle('mcp:list', () => {
    const mcp = require('./mcp-manager');
    return mcp.listMcpServers();
  });
  ipcMain.handle('mcp:add', (_e, spec) => {
    const mcp = require('./mcp-manager');
    return mcp.addMcpServer(spec || {});
  });
  ipcMain.handle('mcp:remove', (_e, id) => {
    const mcp = require('./mcp-manager');
    return mcp.removeMcpServer(String(id || ''));
  });
  ipcMain.handle('mcp:toggle', (_e, id, enabled) => {
    const mcp = require('./mcp-manager');
    return mcp.toggleMcpServer(String(id || ''), !!enabled);
  });
  ipcMain.handle('mcp:recommended', async () => {
    const mcp = require('./mcp-manager');
    return mcp.fetchMcpRecommendations(20);
  });
  // 应用：提示重启 DSH web（浏览器方式告知用户，不自动重启——3080 由用户管理）
  ipcMain.handle('mcp:apply', () => {
    const mcp = require('./mcp-manager');
    return {
      ok: true,
      patchFile: mcp.getPatchFile(),
      restartHint: '配置已写入 cordis.patch.yml。请重启 DSH web (3080) 生效：关闭运行 DSH 的终端/任务后重新运行 dsh --profile web。重启后 MCP 工具（mcp__服务器名__工具名）在 GUI 与 QQ 对话中可用。',
    };
  });
}

function maybeInjectWatcherRemoval() {
  // 停止注入：通过重新加载页面让旧脚本失效（旧脚本仍在运行但不影响，仅停止新注入）
  if (mainWindow && !mainWindow.isDestroyed()) {
    // 不强制刷新用户页面；仅说明注入已停
  }
}

// ================= 启动 =================

app.whenReady().then(async () => {
  try {
    await boot();
    // Skill 开关 → 同步到 DSH skills 目录（~/.dsh/skills）
    syncSkillsToDsh();
    if (process.env.DSH_DESKTOP_SMOKE === '1') {
      console.log('[smoke] app boot OK');
      setTimeout(() => {
        const shellLoaded = mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.getURL().includes('shell.html');
        const guest = guestContents && !guestContents.isDestroyed() ? guestContents.getURL() : '(无)';
        console.log(`[smoke] shell=${shellLoaded ? 'OK' : 'FAIL'} guest=${guest}`);
        app.exit(0);
      }, 3000);
    }
    if (process.env.DSH_DESKTOP_WP_DEBUG === '1') {
      // 壁纸调试：验证 insertCSS（CSS 注入，不执行 JS）能否透明化 DSH 页面
      setTimeout(async () => {
        try {
          const css = `
            html, body { background: transparent !important; }
            body > div, #root, #root > div, #root > main, #root > section, #root > aside { background: transparent !important; }
          `;
          const key = guestContents && !guestContents.isDestroyed()
            ? await guestContents.insertCSS(css).catch((e) => 'CSSERR:' + e.message)
            : 'NO_GUEST';
          console.log(`[wp-debug] insertCSS=${String(key).slice(0, 30)}`);
          // 简单查询验证（尽量短小）
          const probe = guestContents && !guestContents.isDestroyed()
            ? await guestContents.executeJavaScript(`(function(){
                try {
                  var out = { bodyBg: getComputedStyle(document.body).backgroundColor };
                  var root = document.querySelector('#root');
                  if (root) out.rootBg = getComputedStyle(root).backgroundColor;
                  var div = document.body.children.length > 1 ? document.body.children[1] : null;
                  if (div && div.tagName === 'DIV') out.mainDivBg = getComputedStyle(div).backgroundColor;
                  return JSON.stringify(out);
                } catch(e) { return 'ERR:' + e.message; }
              })()`, true).catch((e) => 'ERR:' + e.message)
            : 'NO_GUEST';
          console.log(`[wp-debug] probe=${probe}`);
          console.log(`[wp-debug] settings=${JSON.stringify(appSettings.wallpaper)}`);
        } catch (e) {
          console.log('[wp-debug] 异常:', e.message);
        }
        app.exit(0);
      }, 12000);
    }
  } catch (e) {
    console.error('[main] 启动失败:', e);
    app.exit(1);
  }
});

async function boot() {
  app.setAppUserModelId('com.dsh.desktop');
  loadAppSettings();

  // 服务
  pluginManager = new PluginManager({
    pluginsDir: userDataFile('plugins'),
    settingsFile: userDataFile('settings.json'),
    env: {
      os: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      dsh: '0.1.0-rc.7',
      node: process.versions.node,
      app: app.getVersion(),
    },
    log: console,
  });
  memoryService = new MemoryService({
    memoryDir: userDataFile('memory'),
    settingsFile: userDataFile('memory.json'),
    log: console,
  });
  wallpaperEngine = new WallpaperEngine({ uiDir: UI_DIR, log: console });
  registry = new Registry({
    localPath: REGISTRY_LOCAL,
    remoteUrl: appSettings.registryUrl,
    log: console,
  });

  // QQ 同步桥：QQ 消息 → GUI 会话（DSH web 3080）→ 回复回 QQ
  const qqPending = []; // [{ text, resolve, timer }]
  const NEW_CHAT_RE = /^(创建|新建|开始|开个)?(新的?)?(对话|会话|聊天)|^(重置|清空|清除)(对话|会话|聊天|上下文)?|重新开始/i;
  let qqGuiSessionId = null; // 缓存的 GUI 会话 id
  const GUI_CWD_HINTS = [app.getPath('home') + '\\.dsh-hcwd', process.cwd()].filter(Boolean);
  async function qqGuiSend(text, extra = {}) {
    const { sendToGuiSession, findGuiSession } = require('./qq-gui');
    if (!qqGuiSessionId) {
      try {
        const found = await findGuiSession(GUI_CWD_HINTS);
        qqGuiSessionId = found?.sessionId || null;
        console.log('[qq] GUI 会话: ' + qqGuiSessionId);
      } catch (e) {
        console.log('[qq] 查找 GUI 会话失败: ' + e.message);
      }
    }
    return sendToGuiSession(text, {
      cwdHints: GUI_CWD_HINTS,
      baseSessionId: qqGuiSessionId,
      log: console,
      ...(extra.onProgress ? { onProgress: extra.onProgress } : {}),
    });
  }
  async function findGuiSessionSafe() {
    const { findGuiSession } = require('./qq-gui');
    const found = await findGuiSession(GUI_CWD_HINTS);
    qqGuiSessionId = found?.sessionId || null;
    return qqGuiSessionId;
  }
  async function qqGuiNewChat() {
    const { rpc } = require('./qq-gui');
    try {
      const sid = qqGuiSessionId || (await findGuiSessionSafe());
      if (!sid) return '检测到 DSH web 未运行，无法新建对话。';
      const v = await rpc('session.fork', { sessionId: sid });
      qqGuiSessionId = v.sessionId;
      console.log('[qq] 新建对话（fork）→ ' + qqGuiSessionId);
      return '已为你创建新的对话 ✅（GUI 会话已切换，从此处开始全新内容）。有什么想聊的？';
    } catch (e) {
      return '新建对话失败: ' + e.message;
    }
  }
  qqBridge = new QQBridge({
    log: console,
    getSettings: () => appSettings.qq || {},
    onAsk: (text, ctx) =>
      new Promise((resolve, reject) => {
        const send = ctx?.send || (() => {});
        // 纯"新建对话"指令：fork 新会话（真正的新对话，GUI 可见）
        if (NEW_CHAT_RE.test(text.trim())) {
          console.log('[qq] 新建对话指令，fork 新会话');
          qqGuiNewChat()
            .then(resolve)
            .catch((e) => reject(new Error('新建对话失败: ' + e.message)));
          return;
        }
        console.log('[qq] 发送到 GUI 会话: ' + text.slice(0, 60));
        // 软超时：超过 60 秒先回"仍在处理"，后台继续等，完成后用 ctx.send 补发最终结果
        const SOFT_TIMEOUT_MS = 60000;
        const HARD_TIMEOUT_MS = 600000; // 10 分钟硬上限
        let finished = false;
        let streamedAny = false; // 是否已流式推送过内容（避免重复发完整回复）
        const timer = setTimeout(() => {
          const i = qqPending.findIndex((p) => p.timer === timer);
          if (i >= 0) qqPending.splice(i, 1);
          console.log('[qq] 软超时（60 秒），转 pending');
          finished = true;
          resolve({ type: 'pending', message: '⏳ 正在处理中，可能需要一些时间（任务较长时请稍候）。完成后我会在这里告诉你结果。' });
        }, SOFT_TIMEOUT_MS);
        const hardTimer = setTimeout(() => {
          finished = true;
          send('⏳ 任务已超过 10 分钟仍未完成，可能卡住了。你可以在电脑端 GUI 里查看进度，或发「新建对话」重置。');
        }, HARD_TIMEOUT_MS);
        qqPending.push({ text, resolve, timer });
        // 流式推送（onChunk）+ 进度报告（onProgress）→ 转发到 QQ
        qqGuiSend(text, {
          onChunk: (chunk, isFinal) => {
            streamedAny = true;
            console.log('[qq] 流式: ' + String(chunk || '').slice(0, 40) + (isFinal ? ' [尾]' : ''));
            if (chunk) send(String(chunk));
          },
          onProgress: (phase) => {
            console.log('[qq] 进度: ' + phase);
            send('⏳ ' + phase + '（完成后通知你）');
          },
        })
          .then((r) => {
            clearTimeout(timer);
            clearTimeout(hardTimer);
            const i = qqPending.findIndex((p) => p.timer === timer);
            if (i >= 0) qqPending.splice(i, 1);
            if (finished) {
              // 软超时已回复 pending —— 这里补发最终结果
              if (r.ok) {
                console.log('[qq] GUI 最终回复(补发): ' + String(r.text || '').slice(0, 60));
                if (!streamedAny) send('✅ ' + r.text);
                else send('✅ (已完成，内容已实时发送)');
              } else {
                console.log('[qq] GUI 最终失败(补发): ' + r.error);
                send('⚠️ ' + (r.error || 'GUI 无回复'));
              }
              return;
            }
            if (r.ok) {
              console.log('[qq] GUI 回复: ' + String(r.text || '').slice(0, 60));
              // 流式推送过 → 不再发完整回复（避免重复）；否则发完整
              if (streamedAny) resolve({ type: 'pending', message: '' }); // 已完成，无需再发
              else resolve(r.text);
            } else {
              console.log('[qq] GUI 回复失败: ' + r.error);
              if (r.error && r.error.includes('正忙')) {
                finished = true;
                resolve({ type: 'pending', message: '⏳ AI 当前正忙，你的消息已排队，稍后处理完会自动通知你。' });
              } else {
                reject(new Error(r.error || 'GUI 无回复'));
              }
            }
          })
          .catch((e) => {
            console.log('[qq] GUI 调用失败: ' + e.message);
            clearTimeout(timer);
            clearTimeout(hardTimer);
            const i = qqPending.findIndex((p) => p.timer === timer);
            if (i >= 0) qqPending.splice(i, 1);
            if (finished) {
              send('⚠️ ' + e.message);
              return;
            }
            reject(e);
          });
      }),
  });
  // preload → 主进程：DSH 页面回复（GUI 桥接模式忽略，避免与 GUI 会话竞争误报）
  ipcMain.on('qq:answer', (_e, reply) => {
    console.log('[qq] 页面轮询回复（GUI 桥接模式忽略）: ' + String(reply || '').slice(0, 40));
  });
  ipcMain.on('qq:answer-error', (_e, err) => {
    console.log('[qq] 页面错误（GUI 桥接模式忽略）: ' + err);
  });
  ipcMain.on('qq:debug', (_e, msg) => {
    console.log('[qq:debug] ' + msg);
  });
  if (appSettings.qq) qqBridge.sync();

  registerIpc();
  createMainWindow();
  createTray();
  await activatePlugins();
  await applyWallpaperPlugin();

  // 启动时若有交接摘要且开启自动注入 → 注入
  if (memoryService.loadSettings().autoInjectHandoff) {
    setTimeout(async () => {
      const handoff = await memoryService.getHandoff();
      if (handoff && guestContents && !guestContents.isDestroyed()) {
        const ok = await guestContents
          .executeJavaScript(injectHandoffScript(handoff.summary), true)
          .catch(() => false);
        if (ok) console.log('[memory] 已自动注入上次会话交接摘要');
      }
    }, 8000);
  }
}

function createTray() {
  rebuildTray();
}

/** 向所有 UI 窗口广播事件 */
function broadcast(channel, data) {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send(channel, data);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

app.on('second-instance', () => {
  if (mainWindow) {
    mainWindow.isMinimized() ? mainWindow.restore() : mainWindow.show();
    mainWindow.focus();
  }
});

app.on('before-quit', () => {
  deactivatePlugins();
});

app.on('window-all-closed', () => {
  // 保持托盘常驻；用户通过托盘退出
});

process.on('uncaughtException', (e) => {
  console.error('[main] 未捕获异常:', e);
});