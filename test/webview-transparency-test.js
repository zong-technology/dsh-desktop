'use strict';
/**
 * webview-transparency-test.js — 实测 webview guest 页面透明后，背后 DOM 是否可见。
 * #bg 设纯红背景，webview 加载透明 body 页面；按 webview 区域截图取中心像素。
 * 红色 = 透出（壁纸方案可行）；白色 = webview 表面不透明（需要替代方案）。
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: true, // capturePage 需要窗口实际合成
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
    },
  });

  await win.loadFile(path.join(__dirname, '..', 'ui', 'shell.html'));

  await win.webContents.executeJavaScript(`(() => {
    const bg = document.getElementById('bg');
    bg.style.background = 'rgb(255,0,0)';
    const wv = document.getElementById('dsh');
    wv.style.zIndex = '2';
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 1200));

  // 直接改 webview src 加载透明页面（webview 已 attach，改 src 即导航）
  const rect = await win.webContents.executeJavaScript(`(() => {
    const w = document.getElementById('dsh');
    w.src = 'data:text/html,<body style="background:transparent;margin:0"><div style="color:black;padding:20px">T</div></body>';
    const r = w.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`);
  await new Promise((r) => setTimeout(r, 3000)); // 等导航完成

  console.log('webview 区域:', JSON.stringify(rect));
  const dbg = await win.webContents.executeJavaScript(`(() => {
    const bg = document.getElementById('bg');
    const wv = document.getElementById('dsh');
    const cs = bg ? getComputedStyle(bg) : null;
    const wcs = wv ? getComputedStyle(wv) : null;
    return {
      bgExists: !!bg,
      bgBg: cs ? cs.backgroundColor : null,
      bgZ: cs ? cs.zIndex : null,
      bgRect: bg ? JSON.parse(JSON.stringify(bg.getBoundingClientRect())) : null,
      wvExists: !!wv,
      wvZ: wcs ? wcs.zIndex : null,
      wvRect: wv ? JSON.parse(JSON.stringify(wv.getBoundingClientRect())) : null,
    };
  })()`);
  console.log('诊断:', JSON.stringify(dbg));
  const img = await win.webContents.capturePage(); // 全窗口截图
  const size = img.getSize();
  const bmp = img.toBitmap();
  const W = size.width, H = size.height;
  let red = 0, white = 0, other = 0;
  for (let i = 0; i < bmp.length; i += 4) {
    const rr = bmp[i], gg = bmp[i + 1], bb = bmp[i + 2];
    if (rr > 200 && gg < 80 && bb < 80) red++;
    else if (rr > 200 && gg > 200 && bb > 200) white++;
    else other++;
  }
  const total = W * H;
  const redPct = (red / total * 100).toFixed(1);
  const whitePct = (white / total * 100).toFixed(1);
  console.log(`截图 ${W}x${H}  红色 ${redPct}%  白色 ${whitePct}%  其他 ${(other/total*100).toFixed(1)}%`);

  let verdict;
  if (redPct > 30) verdict = 'PASS（红色背景大面积透出 → webview 透明可行，壁纸可见）';
  else if (whitePct > 30) verdict = 'FAIL（大面积白色 → webview 表面不透明，盖住壁纸）';
  else verdict = `不确定（红 ${redPct}% 白 ${whitePct}%）`;
  console.log('结果:', verdict);
  app.exit(redPct > 30 ? 0 : 1);
}).catch((e) => {
  console.error('失败:', e.message);
  app.exit(1);
});