'use strict';
/**
 * preload.js — 设置窗口桥接（通用 invoke/on）
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshApi', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  once: (channel, cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.once(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
