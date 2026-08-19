'use strict';
// 深查 DSH 页面所有层级背景，找出遮挡壁纸的容器
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadURL('http://127.0.0.1:3080');
  await new Promise((r) => setTimeout(r, 8000));
  const info = await win.webContents.executeJavaScript(`(() => {
    try {
      var t = document.getElementById('__dshdesktop_wp_css');
      if (!t) { t = document.createElement('style'); t.id = '__dshdesktop_wp_css'; document.head.appendChild(t); }
      t.textContent = 'html,body{background:transparent !important;}';
      const solid = [];
      const walk = (el, depth) => {
        try {
          if (depth > 6 || el.children.length > 300) return;
          const cs = getComputedStyle(el);
          const bg = cs.backgroundColor || '';
          const isSolid = bg && /rgb\(/.test(bg) && !/rgba\(0,\s*0,\s*0,\s*0\)/.test(bg);
          const r = el.getBoundingClientRect();
          if (isSolid && r.width > 80 && r.height > 50) {
            solid.push({ tag: el.tagName, cls: String(el.className||'').slice(0,60), bg, a: Math.round(r.width*r.height) });
          }
          for (const c of el.children) walk(c, depth + 1);
        } catch (e) {}
      };
      walk(document.body, 0);
      solid.sort((a,b) => b.a - a.a);
      return JSON.stringify({ bodyBg: getComputedStyle(document.body).backgroundColor, solid: solid.slice(0, 12) });
    } catch (e) { return JSON.stringify({ err: e.message }); }
  })()`);
  console.log(JSON.stringify(JSON.parse(info), null, 1));
  app.exit(0);
}).catch((e) => { console.error('失败:', e.message); app.exit(1); });