'use strict';
/**
 * markdown-export 插件 main —— 一键导出当前 DSH 对话为 Markdown。
 * 演示插件 API：activate/deactivate、addTrayItem、registerIpc、ctx.memory。
 */
const { dialog, Notification } = require('electron');
const fs = require('fs');

module.exports = {
  name: 'Markdown 导出',

  activate(ctx) {
    ctx.log.log('[markdown-export] 已激活 ✅');
    this._ctx = ctx;
    this._trayKey = ctx.addTrayItem('📄 导出对话为 Markdown', () => {
      this._export().then((r) => {
        if (r.ok) {
          new Notification({ title: 'Markdown 导出', body: `已导出: ${r.path}` }).show();
        } else if (!r.canceled) {
          new Notification({ title: 'Markdown 导出', body: `导出失败: ${r.error}` }).show();
        }
      });
    });
    ctx.registerIpc('markdown-export:run', async () => this._export());
  },

  deactivate(ctx) {
    if (this._trayKey) {
      ctx.removeTrayItem(this._trayKey);
      this._trayKey = null;
    }
  },

  async _export() {
    const ctx = this._ctx;
    const snap = ctx.memory && ctx.memory._latest;
    if (!snap || !snap.text) return { ok: false, error: '暂无对话快照（请先在 DSH 页面产生对话）' };
    const win = ctx.mainWindow || undefined;
    const r = await dialog.showSaveDialog(win, {
      title: '导出对话为 Markdown',
      defaultPath: `DSH-对话-${new Date().toISOString().slice(0, 10)}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    try {
      const md = [
        '# DSH 对话导出',
        '',
        `> 导出时间：${new Date().toISOString()}`,
        `> 来源会话：${snap.title || 'DSH 会话'}`,
        '',
        '---',
        '',
        snap.text,
      ].join('\n');
      fs.writeFileSync(r.filePath, md, 'utf8');
      return { ok: true, path: r.filePath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  test() {
    return Promise.resolve();
  },
};