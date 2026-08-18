'use strict';
/**
 * hello-demo 插件 main —— 在 Electron 主进程运行（require('electron') 可用）。
 * 契约：exports.activate(ctx) / exports.deactivate(ctx) / exports.test()。
 */
const { Notification } = require('electron');

module.exports = {
  name: 'Hello 示例插件',

  activate(ctx) {
    ctx.log.log('[hello-demo] 已激活 ✅');
    // 示例：向托盘贡献一个菜单项
    this._trayKey = ctx.addTrayItem('🔔 Hello 示例插件', () => {
      new Notification({ title: 'Hello 示例插件', body: '插件系统工作正常！' }).show();
    });
  },

  deactivate(ctx) {
    if (this._trayKey) {
      ctx.removeTrayItem(this._trayKey);
      this._trayKey = null;
    }
  },

  test() {
    // 供主进程加载测试调用（manifest 里也配置了独立 test.js 脚本）
    return Promise.resolve();
  },
};