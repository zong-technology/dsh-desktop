'use strict';
// 真装测试：3 个 GitHub 插件走完整安全协议链
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.whenReady().then(async () => {
  try {
    const PM = require(path.join(__dirname, '..', 'src', 'plugin-manager'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plg-'));
    const pm = new PM({
      pluginsDir: path.join(tmp, 'plugins'),
      settingsFile: path.join(tmp, 'settings.json'),
      env: {
        os: process.platform,
        arch: process.arch,
        electron: process.versions.electron,
        dsh: '0.1.0-rc.7',
        node: process.versions.node,
        app: app.getVersion(),
      },
      log: console,
    });
    const base = path.resolve(__dirname, '..');
    let pass = true;
    for (const sub of ['chat-stats', 'quick-prompts', 'markdown-export']) {
      try {
        const r = await pm.installFromSpec('local:plugins/' + sub, path.join(base, 'plugins', sub));
        console.log(`[install-test] ${sub} => ${r.ok ? '通过 ✅' : '失败 ❌ ' + r.error}`);
        if (!r.ok) pass = false;
      } catch (e) {
        console.log(`[install-test] ${sub} => 异常 ❌ ${e.message}`);
        pass = false;
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(pass ? '[install-test] 结果: PASS' : '[install-test] 结果: FAIL');
    app.exit(pass ? 0 : 1);
  } catch (e) {
    console.error('[install-test] 失败:', e.message);
    app.exit(1);
  }
});