'use strict';
const fs = require('fs');
const path = require('path');
const dir = process.env.PLUGIN_DIR;
try {
  if (!dir) throw new Error('缺少 PLUGIN_DIR');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (manifest.id !== 'image-viewer') throw new Error(`id 不符: ${manifest.id}`);
  const src = fs.readFileSync(path.join(dir, 'main.js'), 'utf8');
  if (!src.includes('open') || !src.includes('IMG_EXT') || !src.includes('BrowserWindow')) throw new Error('main.js 结构不完整');
  console.log('[image-viewer] 测试通过 ✅');
  process.exit(0);
} catch (e) {
  console.error(`[image-viewer] 测试失败 ❌: ${e.message}`);
  process.exit(1);
}