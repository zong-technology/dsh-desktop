'use strict';
/**
 * wallpaper-e2e.js — 端到端验证「客户端会话背景壁纸」：
 * 真实加载 shell.html（含 preload.js + shell.js），stub 主进程 IPC，
 * 用用户真实的视频壁纸路径，检查 #bg video 是否成功加载并播放。
 * 用法: npx electron test/wallpaper-e2e.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const VIDEO = 'D:\\Program Files (x86)\\Steam\\steamapps\\workshop\\content\\431960\\3406748541\\lv_0_20250113195402.mp4';
const WP = { type: 'video', source: VIDEO, enabled: true, mode: 'window', interval: 60 };

app.whenReady().then(async () => {
  ipcMain.handle('window:state', () => ({ maximized: false }));
  ipcMain.handle('app:info', () => ({
    appVersion: '0.1.0',
    electron: process.versions.electron,
    node: process.versions.node,
    dshVersion: 'rc.7',
    dshUrl: 'http://127.0.0.1:3080',
    os: process.platform,
    arch: process.arch,
    pluginsDir: '',
    memoryDir: '',
    wallpaperSupported: true,
    builtins: { wallpaperPlugin: true, memoryPlugin: true },
  }));
  ipcMain.handle('wallpaper:state', () => ({ settings: WP, active: true }));
  ipcMain.handle('wallpaper:files', () => ({ videos: [], images: [] }));
  ipcMain.handle('app:version', () => '0.1.0');
  ipcMain.handle('memory:handoff', () => null);

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
    },
  });
  win.webContents.on('console-message', (_e, level, msg) => {
    console.log('[renderer]', msg);
  });
  await win.loadFile(path.join(__dirname, '..', 'ui', 'shell.html'));
  await new Promise((r) => setTimeout(r, 4000)); // 等 shell.js 初始化 + renderWallpaper

  // 手动再触发一次 wallpaper:changed（模拟主进程广播）
  win.webContents.send('wallpaper:changed', { settings: WP, active: true });
  await new Promise((r) => setTimeout(r, 1500));

  const info = await win.webContents.executeJavaScript(`(() => {
    const bg = document.getElementById('bg');
    const v = document.querySelector('#bg video');
    const badge = document.getElementById('wp-badge');
    return {
      bgClass: bg ? bg.className : null,
      hasVideo: !!v,
      videoSrc: v ? v.src : null,
      videoError: v && v.error ? v.error.code : null,
      videoReady: v ? v.readyState : null,
      videoPaused: v ? v.paused : null,
      badgeShown: badge ? badge.classList.contains('show') : null,
      badgeText: badge ? badge.textContent : null,
    };
  })()`);

  console.log('=== 壁纸渲染状态 ===');
  console.log(JSON.stringify(info, null, 1));

  const pass =
    info.hasVideo &&
    info.videoSrc.startsWith('file:///') &&
    info.videoError === null &&
    info.bgClass === 'bg on' &&
    info.badgeShown === true;
  console.log(pass ? '结果: PASS（视频壁纸已加载，src=file:// URL）' : '结果: FAIL');
  app.exit(pass ? 0 : 1);
}).catch((e) => {
  console.error('失败:', e.message);
  app.exit(1);
});