'use strict';
/**
 * plugin-manager.js — 插件管理器（安全协议核心执行者）
 *
 * 安装流程（每步失败即回滚删除）：
 *   1. 解析安装源 (GitHub owner/repo@tag | zip URL | local 目录)
 *   2. 下载并解压到临时目录
 *   3. 校验清单 validateManifest
 *   4. 兼容性检查 checkCompat（OS/架构/Electron/DSH/Node 版本）
 *   5. 复制到 plugins/<id>/
 *   6. 运行插件测试（manifest.test 脚本 或 main 导出的 test()）
 *   7. 测试通过 → 注册启用；任何一步失败 → 删除已复制目录并返回错误
 *
 * 插件开关：settings.json 中的 plugins.<id>.enabled
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const { validateManifest, checkCompat, parseVersion, compareVersions } = require('./compat');

const TEST_TIMEOUT_MS = 120000;

class PluginManager {
  /**
   * @param {object} opts
   * @param {string} opts.pluginsDir  插件安装目录
   * @param {string} opts.settingsFile settings.json 路径
   * @param {object} [opts.env]       运行时环境 { os, arch, electron, dsh, node, app }
   * @param {object} [opts.log]       日志
   */
  constructor({ pluginsDir, settingsFile, env = {}, log = console }) {
    this.pluginsDir = pluginsDir;
    this.settingsFile = settingsFile;
    this.env = env;
    this.log = log;
    this._settings = null;
  }

  loadSettings() {
    if (this._settings) return this._settings;
    try {
      this._settings = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
    } catch {
      this._settings = { plugins: {} };
    }
    this._settings.plugins = this._settings.plugins || {};
    return this._settings;
  }

  async saveSettings() {
    const s = this.loadSettings();
    await fsp.mkdir(path.dirname(this.settingsFile), { recursive: true });
    await fsp.writeFile(this.settingsFile, JSON.stringify(s, null, 2), 'utf8');
  }

  /** 列出已安装插件 */
  list() {
    const settings = this.loadSettings();
    if (!fs.existsSync(this.pluginsDir)) return [];
    const out = [];
    for (const id of fs.readdirSync(this.pluginsDir)) {
      const dir = path.join(this.pluginsDir, id);
      const mf = path.join(dir, 'manifest.json');
      if (!fs.statSync(dir).isDirectory() || !fs.existsSync(mf)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
        const state = settings.plugins[id] || {};
        out.push({
          id,
          manifest,
          path: dir,
          enabled: !!state.enabled,
          installedAt: state.installedAt || null,
          source: state.source || null,
          kind: manifest.kind || 'plugin',
        });
      } catch (e) {
        this.log.warn?.(`插件 ${id} 清单解析失败: ${e.message}`);
      }
    }
    return out;
  }

  get(id) {
    return this.list().find((p) => p.id === id) || null;
  }

  /**
   * 安装插件。失败自动回滚（删除已复制目录）。
   * @param {string} spec 'owner/repo' | 'owner/repo@tag' | 'owner/repo@latest' | 'https://...zip' | 'local:C:\\dir'
   */
  async installFromSpec(spec, opts = {}) {
    this.log.log?.(`开始安装: ${spec}`);
    const plan = await this._resolvePlan(spec);
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshplug-'));
    let dest = null;
    try {
      if (plan.kind === 'local') {
        await this._stageFromDir(plan.dir, tmp);
      } else {
        const zipPath = path.join(tmp, 'bundle.zip');
        this.log.log?.(`下载 ${plan.url} ...`);
        await this._download(plan.url, zipPath);
        await this._extractZip(zipPath, path.join(tmp, 'x'));
      }

      const { manifest, root } = await this._findManifest(tmp);
      const v = validateManifest(manifest);
      if (!v.ok) throw new Error(`清单无效: ${v.errors.join('; ')}`);

      const c = checkCompat(manifest, this.env);
      if (!c.ok) throw new Error(`兼容性检查失败: ${c.errors.join('; ')}`);

      // 幂等/重复检查
      const existing = this.get(manifest.id);
      if (existing) {
        const cur = parseVersion(existing.manifest.version);
        const want = parseVersion(manifest.version);
        if (cur && want && compareVersions(want, cur) <= 0) {
          throw new Error(`插件 ${manifest.id} 已安装 (v${existing.manifest.version})，需更高版本才能覆盖`);
        }
        // 允许版本升级覆盖
        await this._safeRemove(existing.path);
      }

      dest = path.join(this.pluginsDir, manifest.id);
      await fsp.mkdir(this.pluginsDir, { recursive: true });
      await this._copyDir(root, dest);

      // —— 测试阶段（安全协议）——
      await this._runPluginTest(manifest, dest);

      // 测试通过 → 注册
      const settings = this.loadSettings();
      settings.plugins[manifest.id] = {
        enabled: true,
        installedAt: new Date().toISOString(),
        version: manifest.version,
        source: spec,
      };
      await this.saveSettings();
      this.log.log?.(`✅ 安装成功: ${manifest.id}@${manifest.version} (测试通过)`);
      return { ok: true, manifest, path: dest };
    } catch (err) {
      // —— 回滚：删除已复制目录 ——
      if (dest) await this._safeRemove(dest);
      this.log.warn?.(`❌ 安装失败，已回滚删除: ${spec} — ${err.message}`);
      return { ok: false, error: err.message, spec };
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  }

  /** 切换插件开关 */
  async toggle(id, enabled) {
    const settings = this.loadSettings();
    if (!settings.plugins[id]) settings.plugins[id] = {};
    settings.plugins[id].enabled = !!enabled;
    await this.saveSettings();
    return { ok: true, id, enabled: !!enabled };
  }

  /** 卸载插件（删除目录 + 移除注册） */
  async uninstall(id) {
    const p = this.get(id);
    if (!p) return { ok: false, error: `插件 ${id} 未安装` };
    await this._safeRemove(p.path);
    const settings = this.loadSettings();
    delete settings.plugins[id];
    await this.saveSettings();
    return { ok: true, id };
  }

  // ---------- 内部实现 ----------

  async _resolvePlan(spec) {
    spec = String(spec || '').trim();
    if (!spec) throw new Error('安装源为空');
    if (spec.startsWith('local:')) {
      const dir = spec.slice('local:'.length);
      if (!fs.existsSync(dir)) throw new Error(`本地目录不存在: ${dir}`);
      return { kind: 'local', dir, spec };
    }
    if (/^https?:\/\//.test(spec)) {
      if (!/\.zip(?:[?#]|$)/i.test(spec)) {
        // GitHub release asset 页面 URL → 尝试解析 releases/latest 下载
        const m = spec.match(/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/?#]+)/i);
        if (m) return { kind: 'zip', url: `https://github.com/${m[1]}/${m[2]}/releases/download/${m[3]}`, spec };
        throw new Error('仅支持 .zip 直接下载地址');
      }
      return { kind: 'zip', url: spec, spec };
    }
    const m = spec.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:@([A-Za-z0-9_.\-]+))?$/);
    if (!m) throw new Error(`无法识别的安装源: ${spec}（支持 owner/repo、owner/repo@tag、zip URL、local:路径）`);
    const [, owner, repo, tag] = m;
    if (!tag || tag === 'latest') {
      // 查最新 release
      const api = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
      let realTag = tag === 'latest' ? null : 'latest';
      try {
        const res = await fetch(api, { headers: { 'User-Agent': 'dsh-desktop', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
        if (res.ok) {
          const data = await res.json();
          realTag = data.tag_name;
        }
      } catch (e) {
        this.log.warn?.(`查询 latest release 失败，回退默认分支: ${e.message}`);
      }
      if (realTag) {
        return { kind: 'zip', url: `https://codeload.github.com/${owner}/${repo}/zip/refs/tags/${encodeURIComponent(realTag)}`, spec, tag: realTag };
      }
      return { kind: 'zip', url: `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/main`, spec };
    }
    return { kind: 'zip', url: `https://codeload.github.com/${owner}/${repo}/zip/refs/tags/${encodeURIComponent(tag)}`, spec, tag };
  }

  async _stageFromDir(dir, tmp) {
    const mf = path.join(dir, 'manifest.json');
    if (!fs.existsSync(mf)) throw new Error(`目录缺少 manifest.json: ${dir}`);
    await this._copyDir(dir, path.join(tmp, 'x'));
  }

  async _download(url, destPath) {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fsp.writeFile(destPath, buf);
  }

  async _extractZip(zipPath, destDir) {
    await fsp.mkdir(destDir, { recursive: true });
    // 优先 tar.exe（Windows 10+ 内置 bsdtar，支持 zip）
    const tar = spawnSync('tar.exe', ['-xf', zipPath, '-C', destDir], { encoding: 'utf8', timeout: 120000 });
    if (tar.status === 0) return;
    // 回退 PowerShell Expand-Archive
    const ps = spawnSync('powershell.exe', [
      '-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ], { encoding: 'utf8', timeout: 180000 });
    if (ps.status !== 0) {
      throw new Error(`解压失败: tar=${tar.stderr || tar.error?.message} ; powershell=${ps.stderr || ps.error?.message}`);
    }
  }

  async _findManifest(baseDir) {
    const candidates = [];
    const walk = async (dir, depth) => {
      if (depth > 3) return;
      let entries = [];
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        if (ent.name === 'node_modules' || ent.name === '.git') continue;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) await walk(p, depth + 1);
        else if (ent.name === 'manifest.json') candidates.push(path.dirname(p));
      }
    };
    await walk(baseDir, 0);
    if (!candidates.length) throw new Error('未找到 manifest.json');
    // 取层级最浅者
    candidates.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
    const root = candidates[0];
    const manifest = JSON.parse(await fsp.readFile(path.join(root, 'manifest.json'), 'utf8'));
    return { manifest, root };
  }

  async _copyDir(src, dest) {
    await fsp.mkdir(dest, { recursive: true });
    for (const ent of await fsp.readdir(src, { withFileTypes: true })) {
      const s = path.join(src, ent.name);
      const d = path.join(dest, ent.name);
      if (ent.isDirectory()) {
        await this._copyDir(s, d);
      } else {
        await fsp.copyFile(s, d);
      }
    }
  }

  async _safeRemove(dir) {
    try { await fsp.rm(dir, { recursive: true, force: true }); } catch (e) {
      this.log.warn?.(`删除失败 ${dir}: ${e.message}`);
    }
  }

  /**
   * 运行插件测试（安全协议：测试不过 = 安装失败 = 回滚）。
   * 契约：
   *   1. manifest.test — JS 脚本路径，用 node 运行，退出码 0 = 通过；
   *      可用环境变量 PLUGIN_DIR / PLUGIN_ID / DSH_DESKTOP_VERSION。
   *   2. 无 test 但 main 存在 — require main；若导出 async test() 则调用，抛错 = 失败；无 test() 则仅做加载检查。
   *   3. 都无 — 仅清单级检查（skill 类纯数据插件允许）。
   */
  async _runPluginTest(manifest, dest) {
    if (manifest.test) {
      const testPath = path.resolve(dest, manifest.test);
      if (!fs.existsSync(testPath)) throw new Error(`测试脚本不存在: ${manifest.test}`);
      this.log.log?.(`运行测试: ${testPath}`);
      await new Promise((resolve, reject) => {
        // 用当前运行时解释器（dev=npm 的 node；Electron 环境下 = electron.exe）
        // 设置 ELECTRON_RUN_AS_NODE=1 使 electron.exe 以纯 node 模式运行测试脚本，
        // 避免触发单实例锁或启动 GUI。
        const child = spawn(process.execPath, [testPath], {
          cwd: dest,
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            PLUGIN_DIR: dest,
            PLUGIN_ID: manifest.id,
            DSH_DESKTOP_VERSION: this.env.app || '',
          },
          stdio: 'inherit',
        });
        const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`测试超时 (>${TEST_TIMEOUT_MS / 1000}s)`)); }, TEST_TIMEOUT_MS);
        child.on('error', (e) => { clearTimeout(t); reject(new Error(`测试启动失败: ${e.message}`)); });
        child.on('exit', (code) => {
          clearTimeout(t);
          if (code === 0) resolve();
          else reject(new Error(`测试失败 (退出码 ${code})`));
        });
      });
      return;
    }
    if (manifest.main) {
      const mainPath = path.resolve(dest, manifest.main);
      if (!fs.existsSync(mainPath)) throw new Error(`main 文件不存在: ${manifest.main}`);
      // 加载检查
      let mod;
      try {
        mod = require(mainPath);
      } catch (e) {
        throw new Error(`main 加载失败: ${e.message}`);
      }
      if (typeof mod.test === 'function') {
        this.log.log?.(`调用 main 导出的 test()...`);
        try {
          await mod.test({ pluginDir: dest, pluginId: manifest.id });
        } catch (e) {
          throw new Error(`test() 未通过: ${e.message}`);
        }
      }
    }
    // 纯数据（skill）插件：无需额外测试
  }
}

module.exports = PluginManager;