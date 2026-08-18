'use strict';
/**
 * inject-watcher.js — 注入 DSH 页面的对话监听脚本（字符串形式，经 executeJavaScript 注入）
 *
 * 周期性读取页面文本快照并通过 window.dshDesktop.reportMemory 上报给主进程。
 * 注入的页面是 DSH Web GUI (localhost:3080)，我们不修改它的任何行为，只读。
 */

const watcherScript = `
(() => {
  if (window.__dshMemoryWatcher) return;
  window.__dshMemoryWatcher = true;
  let lastLen = -1;
  const MIN_DELTA = 400;      // 文本变化超过该字符数才上报
  const MAX_SEND = 300000;    // 单次上报最大字符数（截尾部）

  function snapshot() {
    try {
      const body = document.body;
      if (!body) return;
      const text = body.innerText || '';
      const delta = Math.abs(text.length - lastLen);
      if (lastLen >= 0 && delta < MIN_DELTA) return;
      lastLen = text.length;
      if (window.dshDesktop && typeof window.dshDesktop.reportMemory === 'function') {
        window.dshDesktop.reportMemory({
          text: text.slice(-MAX_SEND),
          title: document.title || '',
          url: location.href || '',
        });
      }
    } catch (e) { /* 静默 */ }
  }

  setInterval(snapshot, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) snapshot(); });
  window.addEventListener('load', () => setTimeout(snapshot, 2000));
  snapshot();
})();
`;

/**
 * 把交接摘要注入到 DSH 输入框的尝试脚本（默认关闭，需在设置中开启）。
 * 只写不读，任何失败都返回 false，绝不破坏页面。
 */
function injectHandoffScript(text) {
  return `
(() => {
  try {
    const escaped = ${JSON.stringify(text)};
    const sel = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
    if (!sel) return false;
    if (sel.tagName === 'TEXTAREA') {
      sel.value = escaped;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      sel.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, escaped);
    }
    return true;
  } catch (e) {
    return false;
  }
})();
`;
}

module.exports = { watcherScript, injectHandoffScript };