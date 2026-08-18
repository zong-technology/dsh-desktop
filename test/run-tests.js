'use strict';
/**
 * run-tests.js — 核心单元/集成测试（纯 Node，无需 Electron GUI）
 *
 * 覆盖（对应安全协议）：
 *   T1 兼容性检查器（semver 范围、OS/架构、未知版本）
 *   T2 清单校验
 *   T3 插件管理器：正常安装 / 测试失败回滚删除 / 兼容性拒绝 / 重复安装 / 开关 / 卸载
 *   T4 上下文记忆：token 估算 / 总结 / 阈值触发 / 交接文件
 *   T5 壁纸引擎：WorkerW 桌面层定位（Windows）
 *
 * 运行：node test/run-tests.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const compat = require('../src/compat');
const PluginManager = require('../src/plugin-manager');
const MemoryService = require('../src/memory');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ❌ ${name} ${detail}`);
  }
}

async function section(name) {
  console.log(`\n=== ${name} ===`);
}

const quietLog = { log: () => {}, warn: () => {}, error: () => {} };

// ============ T1 兼容性 ============

async function T1() {
  await section('T1 兼容性检查器');

  ok('精确版本 1.2.3 满足 "1.2.3"', compat.satisfies('1.2.3', '1.2.3'));
  ok('1.2.4 不满足 "1.2.3"', !compat.satisfies('1.2.4', '1.2.3'));
  ok('* 匹配任意', compat.satisfies('9.9.9', '*'));
  ok('>=28 <34 接受 33', compat.satisfies('33.0.0', '>=28 <34'));
  ok('>=28 <34 拒绝 27', !compat.satisfies('27.0.0', '>=28 <34'));
  ok('^1.2.3 接受 1.9.0', compat.satisfies('1.9.0', '^1.2.3'));
  ok('^1.2.3 拒绝 2.0.0', !compat.satisfies('2.0.0', '^1.2.3'));
  ok('~1.2.3 接受 1.2.9', compat.satisfies('1.2.9', '~1.2.3'));
  ok('~1.2.3 拒绝 1.3.0', !compat.satisfies('1.3.0', '~1.2.3'));
  ok('1.2.x 接受 1.2.8', compat.satisfies('1.2.8', '1.2.x'));
  ok('1.2.x 拒绝 1.3.0', !compat.satisfies('1.3.0', '1.2.x'));
  ok('裸 1 视为 1.x', compat.satisfies('1.7.2', '1'));
  ok('裸 1.2 视为 1.2.x', compat.satisfies('1.2.9', '1.2'));
  ok('|| 或运算: 2.x||3.x 接受 3.2', compat.satisfies('3.2.0', '2.x || 3.x'));
  ok('|| 或运算: 拒绝 4.0', !compat.satisfies('4.0.0', '2.x || 3.x'));
  ok('非法范围字符串 → 保守拒绝', !compat.satisfies('1.2.3', 'garbage!!'));
  ok('空范围任意', compat.satisfies('1.2.3', ''));

  // checkCompat 平台
  const env = { os: 'win32', arch: 'x64', electron: '43.4.0', dsh: '0.1.0-rc.7', node: '24.19.0', app: '0.1.0' };
  ok('兼容环境通过', compat.checkCompat({ compat: { os: ['win32'], electron: '>=28' } }, env).ok);
  const badOs = compat.checkCompat({ compat: { os: ['linux'] } }, env);
  ok('OS 不匹配被拒', !badOs.ok && badOs.errors.some((e) => e.includes('操作系统')));
  const badElectron = compat.checkCompat({ compat: { electron: '>=50' } }, env);
  ok('Electron 版本过高被拒', !badElectron.ok && badElectron.errors.some((e) => e.includes('electron')));
  const unknownEnv = compat.checkCompat({ compat: { dsh: '>=0.2' } }, { ...env, dsh: null });
  ok('无法确定版本 → 按不兼容', !unknownEnv.ok);
  const noCompatField = compat.checkCompat({ name: 'x', version: '1.0.0' }, env);
  ok('无 compat 字段默认通过', noCompatField.ok);
}

// ============ T2 清单校验 ============

async function T2() {
  await section('T2 清单校验');
  ok('合法清单通过', compat.validateManifest({ id: 'my-plugin', name: 'My', version: '1.2.3', kind: 'plugin' }).ok);
  ok('缺 id 拒绝', !compat.validateManifest({ name: 'My', version: '1.2.3' }).ok);
  ok('非法 id 拒绝', !compat.validateManifest({ id: 'bad id!', name: 'My', version: '1.2.3' }).ok);
  ok('缺版本拒绝', !compat.validateManifest({ id: 'my-plugin', name: 'My' }).ok);
  ok('非法 kind 拒绝', !compat.validateManifest({ id: 'my-plugin', name: 'My', version: '1.0.0', kind: 'weird' }).ok);
  ok('非法 compat 拒绝', !compat.validateManifest({ id: 'my-plugin', name: 'My', version: '1.0.0', compat: 'nope' }).ok);
  ok('skill 类型通过', compat.validateManifest({ id: 'skill-x', name: 'X', version: '1.0.0', kind: 'skill' }).ok);
}

// ============ T3 插件管理器 ============

function makePluginDir(name, opts = {}) {
  const dir = path.join(os.tmpdir(), `dsh-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const root = dir; // 插件目录根（manifest.json 位于根，符合 local: 安装约定）
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const manifest = {
    id: opts.id || 'test-plugin',
    name: 'Test',
    version: opts.version || '1.0.0',
    kind: 'plugin',
    main: 'main.js',
    test: opts.test ? 'test.js' : undefined,
    compat: opts.compat || { os: [process.platform], electron: '>=28' },
    ...(opts.extra || {}),
  };
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(root, 'main.js'), `'use strict'; module.exports = { activate() {}, deactivate() {}, test(){ return Promise.resolve(); } };`);
  if (opts.test) fs.writeFileSync(path.join(root, 'test.js'), opts.test);
  if (opts.extraFiles) {
    for (const [rel, content] of Object.entries(opts.extraFiles)) {
      const fp = path.join(root, rel);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content);
    }
  }
  return dir;
}

async function T3() {
  await section('T3 插件管理器（安装/测试/回滚/开关）');

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pm-'));
  const pluginsDir = path.join(base, 'plugins');
  const settingsFile = path.join(base, 'settings.json');
  const env = { os: process.platform, arch: process.arch, electron: '43.4.0', dsh: '0.1.0-rc.7', node: process.versions.node, app: '0.1.0' };
  const pm = new PluginManager({ pluginsDir, settingsFile, env, log: quietLog });

  // 3.1 正常安装（无 test 脚本 → main.test() 加载检查）
  let src311 = null;
  {
    const src = makePluginDir('good');
    src311 = src;
    const r = await pm.installFromSpec('local:' + src);
    ok('正常插件安装成功', r.ok, r.error || '');
    ok('安装目录存在', fs.existsSync(path.join(pluginsDir, 'test-plugin')));
    ok('清单被复制', fs.existsSync(path.join(pluginsDir, 'test-plugin', 'manifest.json')));
    ok('默认已启用', pm.get('test-plugin').enabled === true);
    ok('列表包含', pm.list().some((p) => p.id === 'test-plugin'));
    // 源目录保留到 3.5 重复安装测试后统一清理
  }

  // 3.2 测试脚本失败 → 回滚删除
  {
    const src = makePluginDir('bad', { id: 'test-plugin-bad', test: `process.exit(1);` });
    const r = await pm.installFromSpec('local:' + src);
    ok('测试失败的插件安装被拒', !r.ok && /测试失败/.test(r.error), r.error);
    ok('失败后已回滚删除目录', !fs.existsSync(path.join(pluginsDir, 'test-plugin-bad')));
    fs.rmSync(src, { recursive: true, force: true });
  }

  // 3.2b main.test() 抛错 → 回滚删除
  {
    const src = makePluginDir('badmain', {
      id: 'test-plugin-badmain',
      extraFiles: { 'main.js': `'use strict'; module.exports = { test(){ throw new Error('boom in test'); } };` },
    });
    const r = await pm.installFromSpec('local:' + src);
    ok('main.test 抛错被拒', !r.ok && /test\(\) 未通过/.test(r.error), r.error);
    ok('回滚删除', !fs.existsSync(path.join(pluginsDir, 'test-plugin-badmain')));
    fs.rmSync(src, { recursive: true, force: true });
  }

  // 3.3 兼容性不符 → 拒绝
  {
    const src = makePluginDir('incompat', { id: 'test-plugin-incompat', compat: { os: ['linux'] } });
    const r = await pm.installFromSpec('local:' + src);
    ok('OS 不兼容被拒', !r.ok && /兼容性检查失败/.test(r.error), r.error);
    ok('未遗留目录', !fs.existsSync(path.join(pluginsDir, 'test-plugin-incompat')));
    fs.rmSync(src, { recursive: true, force: true });
  }

  // 3.4 清单无效 → 拒绝
  {
    const src = makePluginDir('badschema', { id: 'test-plugin-badschema', extra: { id: 'bad id!' } });
    const r = await pm.installFromSpec('local:' + src);
    ok('清单无效被拒', !r.ok && /清单无效/.test(r.error), r.error);
    fs.rmSync(src, { recursive: true, force: true });
  }

  // 3.5 重复安装同版本 → 拒绝
  {
    const r = await pm.installFromSpec('local:' + src311);
    ok('重复安装被拒', !r.ok && /已安装/.test(r.error), r.error);
    fs.rmSync(src311, { recursive: true, force: true });
  }

  // 3.6 开关
  {
    await pm.toggle('test-plugin', false);
    ok('关闭后 enabled=false', pm.get('test-plugin').enabled === false);
    await pm.toggle('test-plugin', true);
    ok('重新开启 enabled=true', pm.get('test-plugin').enabled === true);
  }

  // 3.7 卸载
  {
    const r = await pm.uninstall('test-plugin');
    ok('卸载成功', r.ok);
    ok('目录已删除', !fs.existsSync(path.join(pluginsDir, 'test-plugin')));
    ok('列表已移除', !pm.list().some((p) => p.id === 'test-plugin'));
  }

  fs.rmSync(base, { recursive: true, force: true });
}

// ============ T4 上下文记忆 ============

function cjkText(n) {
  // 生成 n 字的中文文本
  const chars = '上下文记忆对话摘要测试插件壁纸安装兼容检查失败回滚删除启用开关功能打包发布'.split('');
  let s = '';
  for (let i = 0; i < n; i++) s += chars[i % chars.length];
  return s;
}

async function T4() {
  await section('T4 上下文记忆');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-'));
  const mem = new MemoryService({ memoryDir: path.join(base, 'memory'), settingsFile: path.join(base, 'memory.json'), log: quietLog });

  ok('中文 token 估算合理', mem.estimateTokens(cjkText(1000)) > 100 && mem.estimateTokens(cjkText(1000)) < 800);

  // 总结内容：contextLimit=6000, threshold=0.5 → 6000 字 ≈ 3600 tokens → pct≈0.6 触发
  await mem.saveSettings({ enabled: true, contextLimit: 6000, summarizeAt: 0.5, deepseekApiKey: '' });
  const text = `# 目标：构建桌面客户端\n- 安装插件\n- 壁纸引擎\n- 上下文记忆\n${cjkText(6000)}`;
  const r = await mem.report({ text, title: '测试会话', url: 'http://x/conv/1' });
  ok('超过阈值触发总结', r.summarized === true, JSON.stringify(r));
  ok('交接文件已写', fs.existsSync(path.join(base, 'memory', 'handoffs')));

  const handoff = await mem.getHandoff();
  ok('交接摘要含要点', handoff && /构建桌面客户端/.test(handoff.summary), handoff && handoff.summary.slice(0, 100));
  ok('HANDOFF.md 已写', fs.existsSync(path.join(base, 'memory', 'HANDOFF.md')));

  // 防抖：紧接着再次上报不重复总结
  const r2 = await mem.report({ text: text + cjkText(100), title: 't', url: 'http://x/2' });
  ok('1 分钟内不重复总结（防抖）', r2.summarized === false);

  // 阈值以下不总结
  const mem2 = new MemoryService({ memoryDir: path.join(base, 'm2'), settingsFile: path.join(base, 'm2.json'), log: quietLog });
  await mem2.saveSettings({ enabled: true, contextLimit: 100000, summarizeAt: 0.7, deepseekApiKey: '' });
  const r3 = await mem2.report({ text: cjkText(500), title: 't', url: 'http://x/3' });
  ok('低于阈值不总结', r3.summarized === false, JSON.stringify(r3));

  // 禁用时不总结
  await mem2.saveSettings({ enabled: false });
  const r4 = await mem2.report({ text: cjkText(99000), title: 't', url: 'http://x/4' });
  ok('禁用时忽略上报', r4.summarized === false);

  fs.rmSync(base, { recursive: true, force: true });
}

// ============ T5 壁纸引擎（Windows） ============

async function T5() {
  await section('T5 壁纸引擎 WorkerW 定位（Windows）');
  if (process.platform !== 'win32') {
    ok('非 Windows 跳过', true);
    return;
  }
  const { findWorkerW } = require('../src/win32-probe');
  const koffi = require('koffi');
  const r = findWorkerW();
  if (r.ok) {
    ok('找到壁纸层 WorkerW', true, `workerW=0x${r.workerW.toString(16)}`);
  } else {
    ok('WorkerW 定位结果（桌面可能未就绪）', false, r.error);
  }
  ok('koffi 正常加载 user32', typeof koffi.load('user32.dll').func === 'function');
}

// ============ 汇总 ============

(async () => {
  console.log('DSH Desktop 测试套件\n----------------------');
  await T1();
  await T2();
  await T3();
  await T4();
  await T5();
  console.log(`\n----------------------\n结果: ${pass} 通过, ${fail} 失败`);
  if (fail) {
    console.log('失败项:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  process.exit(0);
})();