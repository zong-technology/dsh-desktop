'use strict';
/**
 * preload-main.js — DSH 主窗口桥接
 *  - 记忆：memory:report / memory:handoff
 *  - QQ 同步：监听主进程 qq:ask → 操作 DSH 页面输入框发送 → 轮询回复 → qq:answer 上报
 */
const { contextBridge, ipcRenderer } = require('electron');

/* ---------- DSH 页面 DOM 操作（QQ 同步桥） ---------- */

// 找到 DSH 的消息输入框（React 受控组件：用原生 setter + 冒泡 input 事件）
function findInput() {
  const sels = [
    'textarea',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="plaintext-only"]',
    '[contenteditable="true"]',
    'input[type="text"]',
  ];
  for (const sel of sels) {
    const els = document.querySelectorAll(sel);
    // 取最可能可见的（有尺寸且在视口内）
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width > 100 && r.height > 20) return el;
    }
  }
  return null;
}

function setInputValue(el, text) {
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (el.isContentEditable) {
    el.focus();
    // 清空后写入
    el.textContent = '';
    document.execCommand('insertText', false, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('input', { bubbles: true }));
  }
}

function clickSend() {
  // 常见发送按钮特征
  const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
  for (const b of candidates) {
    const t = (b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '');
    const r = b.getBoundingClientRect();
    if (/发送|send|submit/i.test(t) && r.width > 0) {
      b.click();
      return true;
    }
  }
  // fallback：回车
  const input = findInput();
  if (input) {
    const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    return true;
  }
  return false;
}

// 读页面最后一条“非输入框”消息文本（粗略：取消息容器最后一个块）
function readLastReply() {
  const candidates = [
    '[class*="message"] [class*="content"], [class*="message"] [class*="text"]',
    '[class*="Message"] [class*="Content"], [class*="Message"] [class*="Text"]',
    'main [class*="message"], main [class*="Message"]',
  ];
  for (const sel of candidates) {
    const els = document.querySelectorAll(sel);
    if (els.length) {
      const last = els[els.length - 1];
      const t = (last.innerText || '').trim();
      if (t) return t;
    }
  }
  return '';
}

let lastReply = '';
let pollTimer = null;

function startReplyPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    const t = readLastReply();
    if (t && t !== lastReply) {
      const changed = !lastReply || t !== lastReply;
      lastReply = t;
      if (changed) {
        ipcRenderer.send('qq:answer', t.slice(0, 4000));
      }
    }
  }, 1500);
}

function stopReplyPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// 主进程 → 页面：请求对话（收到 qq:ask 后在 DSH 页面输入并发送）
ipcRenderer.on('qq:ask', async (_e, text) => {
  const input = findInput();
  if (!input) {
    ipcRenderer.send('qq:answer-error', 'DSH 输入框未找到（页面可能未就绪）');
    return;
  }
  lastReply = '';
  setInputValue(input, text);
  // 等 React 提交后再点发送
  setTimeout(() => {
    clickSend();
    startReplyPolling();
  }, 300);
});

/* ---------- 暴露给主进程可见的桥接接口 ---------- */

contextBridge.exposeInMainWorld('dshDesktop', {
  reportMemory: (data) => ipcRenderer.send('memory:report', data),
  requestHandoff: () => ipcRenderer.invoke('memory:handoff'),
  // QQ 同步
  qqAsk: (text) => ipcRenderer.invoke('qq:ask-renderer', text),
  qqPollStop: () => stopReplyPolling(),
});
