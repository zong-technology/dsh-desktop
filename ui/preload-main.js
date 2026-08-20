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
  try {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      // React 受控组件：通过原生 setter 设置值 + 触发 input 事件
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (el.isContentEditable) {
      el.focus();
      el.textContent = '';
      document.execCommand('insertText', false, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
  } catch (e) {
    ipcRenderer.send('qq:debug', 'setInputValue 异常: ' + e.message);
    // fallback：直接赋 value
    try {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    } catch (e2) {
      return false;
    }
  }
  return false;
}

function clickSend(tryKey = true) {
  // 常见发送按钮特征（DSH 可能是 SVG 图标按钮，检查 aria-label/title）
  const candidates = Array.from(document.querySelectorAll('button, [role="button"], [class*="send"]'));
  for (const b of candidates) {
    const t = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '') + ' ' + (b.textContent || '');
    const r = b.getBoundingClientRect();
    if ((/发送|send|submit/i.test(t)) && r.width > 0 && r.height > 0) {
      b.click();
      return true;
    }
  }
  // fallback 1：找最后一个可见 button 点击（DSH 发送按钮常是最后/右下角）
  const btns = Array.from(document.querySelectorAll('button')).filter((b) => {
    const r = b.getBoundingClientRect();
    const st = getComputedStyle(b);
    return r.width > 20 && r.height > 20 && st.visibility !== 'hidden' && st.display !== 'none';
  });
  const last = btns[btns.length - 1];
  if (last) {
    last.click();
    return true;
  }
  // fallback 2：回车
  if (tryKey) {
    const input = findInput();
    if (input) {
      const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
      input.dispatchEvent(ev);
      // 部分实现监听 keypress
      const ev2 = new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
      input.dispatchEvent(ev2);
      return true;
    }
  }
  return false;
}

// 读页面文本：取 main/内容区所有可见文本（排除输入框/按钮/隐藏元素）
function readPageText() {
  const texts = [];
  const roots = document.querySelectorAll('main, [class*="conversation"], [class*="message-list"], [class*="session-body"], [class*="chat"]');
  const root = roots[0] || document.body;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const el = n.parentElement;
    if (!el) continue;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'BUTTON' || el.isContentEditable) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const t = (n.nodeValue || '').trim();
    if (t && t.length > 1) texts.push(t);
    if (texts.length > 800) break;
  }
  return texts.join('\n');
}

let replyBase = ''; // 发送后的基准文本：回复 = 基准之后新增的内容
let changeDetectedAt = 0;
let reported = false;
let pollTimer = null;

function startReplyPolling() {
  if (pollTimer) return;
  // 基准 = 当前页面文本（发送后立即记录）
  replyBase = readPageText();
  reported = false;
  pollTimer = setInterval(() => {
    const cur = readPageText();
    if (cur === replyBase) {
      changeDetectedAt = 0;
      return;
    }
    if (reported) {
      // 已上报：不再重复
      return;
    }
    // 第一次变化：记录时间，等待流式回复继续
    if (!changeDetectedAt) {
      changeDetectedAt = Date.now();
      return;
    }
    // 变化持续了 3 秒（或已稳定）→ 上报完整的新增文本
    if (!reported && Date.now() - changeDetectedAt >= 3000) {
      let added = '';
      if (cur.startsWith(replyBase)) {
        added = cur.slice(replyBase.length).trim();
      } else {
        const startIdx = Math.max(0, cur.length - 2000);
        const tail = cur.slice(startIdx);
        let i = 0;
        while (i < tail.length && i < replyBase.length && tail[tail.length - 1 - i] === replyBase[replyBase.length - 1 - i]) i++;
        added = tail.slice(0, Math.max(1, tail.length - i)).trim();
      }
      if (added && added.length > 1 && !/^(正在输入|输入中|停止|取消|生成|思考中)/.test(added)) {
        reported = true;
        ipcRenderer.send('qq:answer', added.slice(0, 4000));
        // 上报后停止轮询（本次对话结束）
        setTimeout(stopReplyPolling, 100);
      } else {
        changeDetectedAt = Date.now(); // UI 文本变化，重置继续等
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
  try {
    const input = findInput();
    if (!input) {
      const info = {
        tag: document.body ? document.body.tagName : 'no-body',
        textareaCount: document.querySelectorAll('textarea').length,
        contenteditableCount: document.querySelectorAll('[contenteditable]').length,
        url: location.href,
      };
      ipcRenderer.send('qq:answer-error', 'DSH 输入框未找到: ' + JSON.stringify(info));
      return;
    }
    ipcRenderer.send('qq:debug', '输入框: ' + (input.tagName || input.getAttribute('role')));
    replyBase = '';
    reported = false;
    const okSet = setInputValue(input, text);
    ipcRenderer.send('qq:debug', 'setInputValue: ' + (okSet ? 'OK' : 'FAIL'));
    // 多轮尝试点击发送（等 React 提交后再点，最多 3 次）
    let sent = false;
    for (let attempt = 0; attempt < 3 && !sent; attempt++) {
      await new Promise((r) => setTimeout(r, 500));
      sent = clickSend(true);
    }
    ipcRenderer.send('qq:debug', '发送: ' + (sent ? 'OK' : 'FAIL'));
    if (sent) startReplyPolling();
    else ipcRenderer.send('qq:answer-error', '无法触发 DSH 发送（输入框或发送按钮未找到）');
  } catch (e) {
    ipcRenderer.send('qq:answer-error', 'preload 异常: ' + (e && e.message ? e.message : String(e)));
  }
});

/* ---------- 暴露给主进程可见的桥接接口 ---------- */

contextBridge.exposeInMainWorld('dshDesktop', {
  reportMemory: (data) => ipcRenderer.send('memory:report', data),
  requestHandoff: () => ipcRenderer.invoke('memory:handoff'),
  // QQ 同步
  qqAsk: (text) => ipcRenderer.invoke('qq:ask-renderer', text),
  qqPollStop: () => stopReplyPolling(),
});
