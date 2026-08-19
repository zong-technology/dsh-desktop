'use strict';
/**
 * quick-prompts 插件 main —— 托盘菜单一键复制常用提示词。
 */
const { clipboard } = require('electron');

module.exports = {
  name: '快捷提示词',

  activate(ctx) {
    ctx.log.log('[quick-prompts] 已激活 ✅');
    this._ctx = ctx;
    this._keys = [];
    for (const [label, text] of Object.entries(this.PROMPTS)) {
      this._keys.push(ctx.addTrayItem(`📋 ${label}`, () => {
        clipboard.writeText(text);
        if (ctx.notify) ctx.notify(`已复制「${label}」到剪贴板`);
      }));
    }
    ctx.registerIpc('quick-prompts:list', () => Object.keys(this.PROMPTS));
    ctx.registerIpc('quick-prompts:copy', (_e, name) => {
      const text = this.PROMPTS[name];
      if (text) clipboard.writeText(text);
      return { ok: !!text };
    });
  },

  deactivate(ctx) {
    if (this._keys) {
      this._keys.forEach((k) => ctx.removeTrayItem(k));
      this._keys = [];
    }
  },

  PROMPTS: {
    '翻译': '请将以下内容翻译成中文，保留原有格式与技术术语：\n\n{{粘贴内容}}',
    '总结': '请用简洁的中文总结以下内容，列出要点：\n\n{{粘贴内容}}',
    '代码审查': '请审查以下代码：指出 bug、安全隐患与可读性问题，并给出改进建议。\n\n{{粘贴内容}}',
    '生成日报': '根据以下工作内容生成一份日报（今日完成 / 明日计划 / 风险）：\n\n{{粘贴内容}}',
  },

  test() {
    return Promise.resolve();
  },
};