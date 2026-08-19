'use strict';
/**
 * chat-stats 插件 main —— 会话统计：消息数 / 字数 / 时长。
 */
const { Notification } = require('electron');

module.exports = {
  name: '会话统计',

  activate(ctx) {
    ctx.log.log('[chat-stats] 已激活 ✅');
    this._ctx = ctx;
    this._trayKey = ctx.addTrayItem('📊 查看会话统计', () => {
      const s = this._stats();
      const body = s.error || `会话: ${s.title || '（未命名）'}\n消息: ${s.lines} 条\n字数: ${s.chars} 字\n时长: ${s.duration}`;
      new Notification({ title: 'DSH Desktop · 会话统计', body }).show();
    });
    ctx.registerIpc('chat-stats:get', () => this._stats());
  },

  deactivate(ctx) {
    if (this._trayKey) {
      ctx.removeTrayItem(this._trayKey);
      this._trayKey = null;
    }
  },

  _stats() {
    const snap = this._ctx.memory && this._ctx.memory._latest;
    if (!snap || !snap.text) return { error: '暂无会话快照（请先在 DSH 页面产生对话）' };
    const text = snap.text;
    const lines = text.split('\n').filter((l) => l.trim().length > 0).length;
    const chars = text.replace(/\s/g, '').length;
    const dur = snap.ts ? Math.max(1, Math.round((Date.now() - snap.ts) / 60000)) : 1;
    return { title: snap.title, lines, chars, duration: `${dur} 分钟` };
  },

  test() {
    return Promise.resolve();
  },
};