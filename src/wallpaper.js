'use strict';
/**
 * wallpaper.js — 动态壁纸引擎（视频 / 网页）
 *
 * 原理（仅 Windows）：
 *   1. 创建无边框、隐藏的 Electron 窗口
 *   2. 用 win32-probe 定位桌面壁纸层 WorkerW
 *   3. SetParent(我们的窗口, 该 WorkerW)，SetWindowPos 铺满虚拟屏幕
 *      → 壁纸显示在桌面图标之下、桌面背景之上（类似 Wallpaper Engine）
 */
const path = require('path');
const { BrowserWindow } = require('electron');
const { findWorkerW } = require('./win32-probe');

const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const HWND_BOTTOM = 1;

class WallpaperEngine {
  /**
   * @param {object} opts { uiDir, log }
   */
  constructor({ uiDir, log = console }) {
    this.uiDir = uiDir;
    this.log = log;
    this.win = null;
    this._user32 = null;
  }

  get supported() {
    return process.platform === 'win32';
  }

  _createWin() {
    this.win = new BrowserWindow({
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      enableLargerThanScreen: true,
      backgroundColor: '#000000',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.win.on('closed', () => {
      this.win = null;
    });
    return this.win;
  }

  async startVideo(filePath) {
    if (!this.supported) throw new Error('动态壁纸仅支持 Windows');
    const page = 'file:///' + path.join(this.uiDir, 'wallpaper.html').replace(/\\/g, '/');
    const src = 'file:///' + String(filePath).replace(/\\/g, '/');
    const url = `${page}?kind=video&src=${encodeURIComponent(src)}`;
    await this._start(url);
    return { ok: true };
  }

  async startWeb(url) {
    if (!this.supported) throw new Error('动态壁纸仅支持 Windows');
    if (!/^https?:\/\//i.test(url)) throw new Error('网页壁纸需要 http(s) 地址');
    await this._start(url);
    return { ok: true };
  }

  async _start(url) {
    if (!this.win) this._createWin();
    this.win.webContents.once('did-finish-load', () => this._attach());
    await this.win.loadURL(url);
    return { ok: true };
  }

  /** 把窗口挂到桌面壁纸层 */
  _attach() {
    this._attachError = null;
    try {
      if (!this.win) return;
      const hwndBuf = this.win.getNativeWindowHandle();
      const hwnd = process.arch === 'x64' ? Number(hwndBuf.readBigUInt64LE(0)) : hwndBuf.readUInt32LE(0);
      if (!hwnd) throw new Error('无法取得窗口句柄');

      const r = findWorkerW();
      if (!r.ok) {
        this.log.warn?.(`壁纸层定位失败: ${r.error}`);
        return;
      }
      if (!this._user32) this._user32 = require('./win32-probe').createKoffi();
      const user32 = this._user32;
      user32.SetParent(hwnd, r.workerW);
      const sm = (i) => user32.GetSystemMetrics(i);
      const x = sm(76);
      const y = sm(77);
      const w = sm(78);
      const h = sm(79);
      user32.SetWindowPos(hwnd, HWND_BOTTOM, x, y, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
      this.log.log?.(`壁纸窗口已挂载到桌面层 (${w}x${h} @ ${x},${y})`);
    } catch (e) {
      this._attachError = e.message;
      this.log.warn?.(`壁纸挂载失败: ${e.message}`);
    }
  }

  async stop() {
    if (this.win) {
      try {
        this.win.destroy();
      } catch (e) {
        this.log.warn?.(`壁纸窗口关闭失败: ${e.message}`);
      }
      this.win = null;
    }
    return { ok: true };
  }

  isActive() {
    return !!this.win && !this.win.isDestroyed();
  }
}

module.exports = WallpaperEngine;