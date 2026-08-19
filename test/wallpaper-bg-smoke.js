'use strict';
/**
 * wallpaper-bg-smoke.js — 验证「会话背景壁纸」方案 v2：
 * inline style + important 方式透明化 html/body，并检查是否还有大块不透明容器遮挡。
 * 用法: npx electron test/wallpaper-bg-smoke.js
 */
const { app, BrowserWindow } = require('electron');

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

    const before = await win.webContents.executeJavaScript(`getComputedStyle(document.body).backgroundColor`).catch(() => 'err');
    console.log('[bg] 初始 body 背景:', before);

    const injected = await win.webContents.executeJavaScript(`(function(){
      try {
        var d = document;
        if (!d.__t_orig) d.__t_orig = {};
        ['html','body'].forEach(function(sel){
          var el = d.querySelector(sel);
          if (!el) return;
          if (d.__t_orig[sel] === undefined) d.__t_orig[sel] = getComputedStyle(el).backgroundColor;
          el.style.setProperty('background', 'transparent', 'important');
        });
        return true;
      } catch(e) { return false; }
    })()`).catch(() => false);
    console.log('[bg] 注入:', injected === true ? 'OK' : 'FAIL');

    await new Promise((r) => setTimeout(r, 500));
    const after = await win.webContents.executeJavaScript(`getComputedStyle(document.body).backgroundColor`).catch(() => 'err');
    console.log('[bg] 注入后 body 背景:', after);

    // 找仍不透明的大容器（>100x60）
    const solid = await win.webContents.executeJavaScript(`(() => {
      const out = [];
      const walk = (el, dep) => {
        try {
          if (dep > 5) return;
          const cs = getComputedStyle(el);
          const bg = cs.backgroundColor || '';
          const solid = /rgb\(/.test(bg) && !/rgba\(0,\s*0,\s*0,\s*0\)/.test(bg);
          const r = el.getBoundingClientRect();
          if (solid && r.width > 100 && r.height > 60) {
            out.push({ tag: el.tagName, cls: String(el.className||'').slice(0,50), bg, a: Math.round(r.width*r.height) });
          }
          for (const c of el.children) walk(c, dep+1);
        } catch (e) {}
      };
      walk(document.body, 0);
      out.sort((a,b) => b.a - a.a);
      return out.slice(0, 8);
    })()`).catch(() => []);
    console.log('[bg] 不透明遮挡容器:', solid.length ? JSON.stringify(solid) : '无（壁纸可透出）');

    const transparent = (v) => /rgba\(0,\s*0,\s*0,\s*0\)|transparent/i.test(String(v));
    const pass = transparent(after) && solid.length === 0;
    console.log(pass ? '[bg] 结果: PASS' : '[bg] 结果: FAIL（body 未透明或仍有遮挡容器）');
    app.exit(pass ? 0 : 1);
  } catch (e) {
    console.error('[bg] 失败:', e.message);
    app.exit(1);
  }
}).catch((e) => {
  console.error('[bg] 初始化失败:', e.message);
  app.exit(1);
});