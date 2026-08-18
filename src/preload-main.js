'use strict';
/**
 * preload-main.js — DSH 主窗口桥接（只暴露记忆相关的最小接口）
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktop', {
  reportMemory: (data) => ipcRenderer.send('memory:report', data),
  requestHandoff: () => ipcRenderer.invoke('memory:handoff'),
});
