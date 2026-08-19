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
let appSettings = null;
let activePlugins = new Map(); // id -> { mod, deactivate }

function userDataFile(name) {
  return path.join(app.getPath('userData'), name);
}

function loadAppSettings() {
  try {
    appSettings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(userDataFile('settings.json'), 'utf8')) };
  } catch {
    appSettings = { ...DEFAULTS };
  }
  appSettings.plugins = appSettings.plugins || {};
  appSettings.wallpaper = appSettings.wallpaper || { type: 'off', source: '', enabled: false, mode: 'window' };
  if (!appSettings.wallpaper.mode) appSettings.wallpaper.mode = 'window';
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
      maybeInjectWatcher();
    });
    guest.on('did-navigate', () => {
      const url = guest.getURL();
      if (url.startsWith('http')) setDshStatus(true);
      maybeInjectWatcher();
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
    parent: mainWindow || undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(SRC_DIR, 'preload.js'),
    },
  });
  settingsWindow.loadFile(path.join(UI_DIR, 'index.html'));
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
    const r = await pluginManager.toggle(String(id), !!enabled);
    if (r.ok) {
      if (id === 'wallpaper-plugin') await applyWallpaperPlugin();
      if (id === 'memory-plugin') maybeInjectWatcher();
    }
    return r;
  });

  ipcMain.handle('registry:recommended', async () => {
    const r = await registry.getRecommended();
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
    if (process.env.DSH_DESKTOP_SMOKE === '1') {
      console.log('[smoke] app boot OK');
      // 验证 shell + 内嵌 DSH webview 已就绪
      setTimeout(async () => {
        const shellLoaded = mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.getURL().includes('shell.html');
        const guest = guestContents && !guestContents.isDestroyed() ? guestContents.getURL() : '(无)';
        // 壁纸客户端背景渲染验证（window 模式 + web 壁纸 → #bg 出现 iframe）
        // 临时启用插件并备份/恢复用户设置
        let wpOk = 'skip';
        const settingsPath = userDataFile('settings.json');
        const backup = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : null;
        try {
          appSettings.plugins = appSettings.plugins || {};
          appSettings.plugins['wallpaper-plugin'] = { enabled: true };
          appSettings.wallpaper = { type: 'web', source: 'https://example.com', enabled: true, mode: 'window' };
          saveAppSettings();
          await applyWallpaperPlugin();
          await new Promise((r) => setTimeout(r, 1500));
          wpOk = await mainWindow.webContents
            .executeJavaScript(`!!document.querySelector('#bg iframe')`, true)
            .catch(() => 'jserr');
        } catch (e) {
          wpOk = 'err:' + e.message;
        } finally {
          if (backup !== null) fs.writeFileSync(settingsPath, backup, 'utf8');
          else fs.rmSync(settingsPath, { force: true });
          loadAppSettings();
          await applyWallpaperPlugin();
        }
        console.log(`[smoke] shell=${shellLoaded ? 'OK' : 'FAIL'} guest=${guest} wallpaperClient=${wpOk ? 'OK' : wpOk}`);
        app.exit(0);
      }, 6000);
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