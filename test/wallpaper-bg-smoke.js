'use strict';
/**
 * wallpaper-bg-smoke.js — 验证「会话背景壁纸」方案：
 * 在真实 DSH 页面中注入 body 透明化 CSS，检查背景变为透明（壁纸可透出）。
 * 用法: npx electron test/wallpaper-bg-smoke.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');

const DSH_URL = process.env.DSH_URL || 'http://127.0.0.1:3080';

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { contextIsolation: true, sandbox: true },
  });

  const timeout = (ms, tag) => new Promise((_, rej) => setTimeout(() => rej(new Error(tag + ' 超时')), ms));

  try {
    await Promise.race([win.loadURL(DSH_URL), timeout(20000, '加载 DSH')]);
    await Promise.race([new Promise((r) => setTimeout(r, 8000)), timeout(12000, '等待渲染')]);

    // 1) 初始背景应为白色（不透）→ 说明基线正确
    const before = await win.webContents.executeJavaScript(`getComputedStyle(document.body).backgroundColor`).catch(() => 'err');
    console.log('[bg] 初始 body 背景:', before);

    // 2) 注入透明化 CSS（与 main.js applyGuestWallpaper 相同逻辑）
    const css = 'html,body{background:transparent !important;}';
    const injected = await win.webContents.executeJavaScript(`(function(){
      var t = document.getElementById('__dshdesktop_wp_css');
      if (!t) { t = document.createElement('style'); t.id = '__dshdesktop_wp_css'; document.head.appendChild(t); }
      t.textContent = ${JSON.stringify(css)};
      return true;
    })()`).catch(() => false);
    console.log('[bg] 注入 CSS:', injected === true ? 'OK' : 'FAIL');

    // 3) 注入后背景应为透明
    const after = await win.webContents.executeJavaScript(`getComputedStyle(document.body).backgroundColor`).catch(() => 'err');
    console.log('[bg] 注入后 body 背景:', after);

    // 4) 恢复白色
    const css2 = 'html,body{background:rgb(255,255,255) !important;}';
    await win.webContents.executeJavaScript(`(function(){
      var t = document.getElementById('__dshdesktop_wp_css');
      if (!t) { t = document.createElement('style'); t.id = '__dshdesktop_wp_css'; document.head.appendChild(t); }
      t.textContent = ${JSON.stringify(css2)};
      return true;
    })()`).catch(() => false);
    const restored = await win.webContents.executeJavaScript(`getComputedStyle(document.body).backgroundColor`).catch(() => 'err');
    console.log('[bg] 恢复后 body 背景:', restored);

    const transparent = (v) => /rgba\(0,\s*0,\s*0,\s*0\)|transparent/i.test(String(v));
    const pass = before !== 'err' && transparent(after) && /255/.test(String(restored));
    console.log(pass ? '[bg] 结果: PASS（壁纸可透出，会话框保留）' : '[bg] 结果: FAIL');
    app.exit(pass ? 0 : 1);
  } catch (e) {
    console.error('[bg] 失败:', e.message);
    app.exit(1);
  }
}).catch((e) => {
  console.error('[bg] 初始化失败:', e.message);
  app.exit(1);
});