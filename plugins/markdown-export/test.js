'use strict';
/**
 * markdown-export 插件测试脚本：退出码 0 = 通过。
 */
const fs = require('fs');
const path = require('path');

const dir = process.env.PLUGIN_DIR;

try {
  if (!dir) throw new Error('缺少 PLUGIN_DIR');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (manifest.id !== 'markdown-export') throw new Error(`id 不符: ${manifest.id}`);
  if (!fs.existsSync(path.join(dir, 'main.js'))) throw new Error('缺少 main.js');
  const src = fs.readFileSync(path.join(dir, 'main.js'), 'utf8');
  if (!src.includes('_export')) throw new Error('main.js 缺少导出逻辑');
  console.log('[markdown-export] 测试通过 ✅');
  process.exit(0);
} catch (e) {
  console.error(`[markdown-export] 测试失败 ❌: ${e.message}`);
  process.exit(1);
}