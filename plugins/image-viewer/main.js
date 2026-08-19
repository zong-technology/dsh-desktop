'use strict';
/**
 * image-viewer 插件 main —— 图片查看器：选择目录 → 幻灯片浏览。
 * 页面通过 file:// 直连本地图片，←/→ 切换，Esc 关闭。
 */
const { BrowserWindow, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

const IMG_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'];

module.exports = {
  name: '图片查看器',

  activate(ctx) {
    ctx.log.log('[image-viewer] 已激活 ✅');
    this._ctx = ctx;
    this._trayKey = ctx.addTrayItem('🖼️ 打开图片查看器', () => this.open());
  },

  deactivate(ctx) {
    if (this._trayKey) {
      ctx.removeTrayItem(this._trayKey);
      this._trayKey = null;
    }
    if (this._win && !this._win.isDestroyed()) this._win.destroy();
    this._win = null;
  },

  async open() {
    const ctx = this._ctx;
    if (this._win && !this._win.isDestroyed()) { this._win.focus(); return; }
    const r = await dialog.showOpenDialog({ title: '选择图片目录', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths.length) return;
    const dir = r.filePaths[0];
    let files;
    try {
      files = fs.readdirSync(dir)
        .filter((f) => IMG_EXT.includes(path.extname(f).toLowerCase()))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map((f) => path.join(dir, f));
    } catch (e) {
      if (ctx.notify) ctx.notify('读取目录失败: ' + e.message);
      return;
    }
    if (!files.length) {
      if (ctx.notify) ctx.notify('该目录没有图片文件');
      return;
    }
    this._win = new BrowserWindow({
      width: 960,
      height: 680,
      title: `图片查看器 · ${path.basename(dir)}（${files.length} 张）`,
      backgroundColor: '#111418',
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    this._win.on('closed', () => { this._win = null; });
    this._urls = files.map((f) => 'file://' + encodeURI(f.replace(/\\/g, '/')));
    this._names = files.map((f) => path.basename(f));
    this._win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(this._html()));
    this._win.webContents.on('did-finish-load', () => {
      this._win.webContents.executeJavaScript(
        `window.__init(${JSON.stringify(this._urls)}, ${JSON.stringify(this._names)}, ${this._names.length})`
      ).catch(() => {});
    });
  },

  _html() {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html,body { margin:0; height:100%; background:#111418; color:#e6e6e6; font-family: system-ui, sans-serif; overflow:hidden; }
  #img { width:100%; height:100%; object-fit:contain; display:block; }
  #bar { position:fixed; left:0; right:0; bottom:0; padding:8px 14px; background:rgba(0,0,0,.55); font-size:13px; display:flex; justify-content:space-between; align-items:center; gap:10px; }
  #info b { color:#ffb04d; }
  .k { border:1px solid #444; border-radius:4px; padding:1px 6px; font-size:11px; color:#aaa; }
</style>
</head>
<body>
<img id="img" alt="">
<div id="bar"><span id="info"></span><span><span class="k">←</span> 上一张 &nbsp; <span class="k">→</span> 下一张 &nbsp; <span class="k">Esc</span> 关闭</span></div>
<script>
  var _urls = [], _names = [], _i = 0;
  window.__init = function(urls, names, total) {
    _urls = urls; _names = names; _i = 0;
    _show();
  };
  function _show() {
    var img = document.getElementById('img');
    img.src = _urls[_i] || '';
    img.alt = _names[_i] || '';
    document.getElementById('info').innerHTML = '<b>' + (_names[_i]||'') + '</b> &nbsp; ' + (_i+1) + ' / ' + _urls.length;
    document.title = (_names[_i]||'') + '（' + (_i+1) + '/' + _urls.length + '）';
  }
  window.__next = function(d) {
    if (!_urls.length) return;
    _i = (_i + d + _urls.length) % _urls.length;
    _show();
  };
  document.addEventListener('keydown', function(e) {
    if (e.key === 'ArrowRight') window.__next(1);
    else if (e.key === 'ArrowLeft') window.__next(-1);
    else if (e.key === 'Escape') window.close();
  });
</script>
</body>
</html>`;
  },

  test() {
    return Promise.resolve();
  },
};