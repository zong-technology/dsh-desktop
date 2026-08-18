'use strict';
/**
 * win32-probe.js — 纯 koffi 的 Win32 桌面探测（无 Electron 依赖，可被单测直接使用）
 * 提供：定位桌面壁纸层 WorkerW（动态壁纸挂载目标）。
 *
 * 注意：koffi v3 的 lib.func() 返回函数但不再挂载到库代理对象上，
 * 因此这里把所有函数收集进 api 对象。
 */
const koffi = require('koffi');

const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;

let cached = null;

function createKoffi() {
  if (cached) return cached; // 单例：避免重复注册 koffi proto 类型（Duplicate type name）
  const lib = koffi.load('user32.dll');
  const EnumWindowsProc = koffi.proto('bool EnumWindowsProc(intptr_t hwnd, intptr_t lparam)');
  const api = {
    FindWindowW: lib.func('intptr_t FindWindowW(const char16_t *cls, const char16_t *name)'),
    SendMessageTimeoutW: lib.func('long SendMessageTimeoutW(intptr_t hwnd, uint msg, uint wparam, uint lparam, uint flags, uint timeout, void *result)'),
    GetWindow: lib.func('intptr_t GetWindow(intptr_t hwnd, int cmd)'),
    GetClassNameW: lib.func('int GetClassNameW(intptr_t hwnd, void *buf, int max)'),
    SetParent: lib.func('intptr_t SetParent(intptr_t child, intptr_t parent)'),
    ShowWindow: lib.func('int ShowWindow(intptr_t hwnd, int cmd)'),
    SetWindowPos: lib.func('int SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint flags)'),
    GetSystemMetrics: lib.func('int GetSystemMetrics(int index)'),
    EnumWindows: lib.func('bool EnumWindows(EnumWindowsProc *cb, intptr_t lparam)'),
    EnumWindowsProc,
  };
  api.virtualScreen = () => ({
    x: api.GetSystemMetrics(SM_XVIRTUALSCREEN),
    y: api.GetSystemMetrics(SM_YVIRTUALSCREEN),
    width: api.GetSystemMetrics(SM_CXVIRTUALSCREEN),
    height: api.GetSystemMetrics(SM_CYVIRTUALSCREEN),
  });
  cached = api;
  return api;
}

/**
 * 定位桌面壁纸层 WorkerW（多策略，兼容 Win10/Win11 各种桌面拓扑）。
 * 策略：
 *   1. 经典法：SHELLDLL_DefView 宿主窗口的下一个兄弟（空 WorkerW）
 *   2. 枚举法：所有可见、无子窗口的 WorkerW，取最顶层
 *   3. 回退：直接使用 Progman
 * @returns {{ok: true, workerW: number|bigint, method: string} | {ok: false, error: string}}
 */
function findWorkerW() {
  const api = createKoffi();
  const progman = api.FindWindowW('Progman', null);
  if (!progman) return { ok: false, error: '未找到 Progman 窗口（桌面未就绪？）' };

  const resBuf = Buffer.alloc(8);
  api.SendMessageTimeoutW(progman, 0x052c, 0, 0, 0x0002 /* SMTO_NORMAL */, 1000, resBuf);

  let defViewHost = null;
  const emptyWorkers = []; // 可见且无子窗口的 WorkerW

  const cb = koffi.register(
    function (hwnd) {
      if (!hwnd) return true;
      const buf = Buffer.alloc(256);
      const n = api.GetClassNameW(hwnd, buf, 128);
      const cls = n > 0 ? buf.toString('utf16le', 0, n * 2).replace(/\0+$/, '') : '';

      if (cls === 'WorkerW') {
        const child = api.GetWindow(hwnd, 5 /* GW_CHILD */);
        if (!child) emptyWorkers.push(hwnd);
        return true;
      }
      // 记录 SHELLDLL_DefView 的宿主（WorkerW 或 Progman）
      if (cls !== 'SHELLDLL_DefView') {
        const child = api.GetWindow(hwnd, 5 /* GW_CHILD */);
        if (child) {
          const cbuf = Buffer.alloc(256);
          const cn = api.GetClassNameW(child, cbuf, 128);
          if (cn > 0 && cbuf.toString('utf16le', 0, cn * 2).replace(/\0+$/, '') === 'SHELLDLL_DefView') {
            defViewHost = hwnd;
          }
        }
      }
      return true;
    },
    koffi.pointer(api.EnumWindowsProc)
  );
  api.EnumWindows(cb, 0);
  koffi.unregister(cb);

  // 策略 1：经典法
  if (defViewHost) {
    const next = api.GetWindow(defViewHost, 2 /* GW_HWNDNEXT */);
    if (next) {
      const nbuf = Buffer.alloc(256);
      const nn = api.GetClassNameW(next, nbuf, 128);
      const ncls = nn > 0 ? nbuf.toString('utf16le', 0, nn * 2).replace(/\0+$/, '') : '';
      if (ncls === 'WorkerW' || ncls === 'SHELLDLL_DefView') {
        return { ok: true, workerW: next, method: 'classic' };
      }
    }
  }
  // 策略 2：枚举空 WorkerW，取最顶层
  if (emptyWorkers.length) {
    return { ok: true, workerW: emptyWorkers[emptyWorkers.length - 1], method: 'enumerate' };
  }
  // 策略 3：回退 Progman
  return { ok: true, workerW: progman, method: 'progman-fallback' };
}

module.exports = { findWorkerW, createKoffi };