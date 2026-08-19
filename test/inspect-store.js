'use strict';
// 检查 DSH 页面 localStorage / IndexedDB 中是否有历史会话数据
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadURL('http://127.0.0.1:3080');
  await new Promise((r) => setTimeout(r, 8000));
  const info = await win.webContents.executeJavaScript(`(async () => {
    const out = { localStorage: [], indexedDB: [] };
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        const v = localStorage.getItem(k);
        out.localStorage.push({ k, len: v ? v.length : 0, head: v ? v.slice(0, 80) : '' });
      }
    } catch (e) { out.localStorage = 'err:' + e.message; }
    try {
      const dbs = await indexedDB.databases ? await indexedDB.databases() : [];
      for (const db of dbs) {
        const req = indexedDB.open(db.name);
        const d = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
        const names = Array.from(d.objectStoreNames);
        out.indexedDB.push({ name: db.name, version: db.version, stores: names });
        d.close();
      }
    } catch (e) { out.indexedDB = 'err:' + e.message; }
    return JSON.stringify(out);
  })()`);
  console.log(JSON.stringify(JSON.parse(info), null, 1));
  app.exit(0);
}).catch((e) => { console.error('失败:', e.message); app.exit(1); });