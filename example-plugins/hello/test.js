'use strict';
/**
 * hello-demo 插件测试脚本。
 * 由插件管理器用 node 运行：退出码 0 = 测试通过，非 0 = 安装失败（自动回滚删除）。
 * 可用环境变量：PLUGIN_DIR / PLUGIN_ID / DSH_DESKTOP_VERSION
 */
const fs = require('fs');
const path = require('path');

const dir = process.env.PLUGIN_DIR;
const id = process.env.PLUGIN_ID;

try {
  if (!dir) throw new Error('缺少 PLUGIN_DIR');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (manifest.id !== 'hello-demo') throw new Error(`id 不符: ${manifest.id}`);
  if (manifest.version !== '1.0.0') throw new Error(`version 不符: ${manifest.version}`);
  if (!fs.existsSync(path.join(dir, 'main.js'))) throw new Error('缺少 main.js');
  console.log(`[hello-demo] 测试通过 ✅ (installed id=${id}, dir=${dir})`);
  process.exit(0);
} catch (e) {
  console.error(`[hello-demo] 测试失败 ❌: ${e.message}`);
  process.exit(1);
}