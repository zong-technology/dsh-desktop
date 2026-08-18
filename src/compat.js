'use strict';
/**
 * compat.js — 兼容性检查器（安全协议第一关）
 *
 * 纯 Node 实现，无外部依赖。所有插件/功能在安装前都必须通过
 * validateManifest() 与 checkCompat()，否则拒绝安装。
 *
 * 支持的版本范围语法（与 npm semver 子集一致）：
 *   "*" | "x"                 任意版本
 *   "1.2.3"                   精确版本
 *   "1.2" / "1"               部分版本 → "1.2.x" / "1.x"
 *   ">=1.2.3" "<=1.2.3" ">1.2.3" "<1.2.3"
 *   "^1.2.3"                  >=1.2.3 <2.0.0
 *   "~1.2.3"                  >=1.2.3 <1.3.0
 *   "1.2.x"                   >=1.2.0 <1.3.0
 *   多个条件用空格分隔 = AND；"||" = OR
 */

function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]*)?$/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], raw: v.trim() };
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

function satisfiesComparator(version, op, ref) {
  const c = compareVersions(version, ref);
  if (c === null) return false;
  switch (op) {
    case '>=': return c >= 0;
    case '<=': return c <= 0;
    case '>': return c > 0;
    case '<': return c < 0;
    case '=':
    case '': return c === 0;
    default: return false;
  }
}

/** 把部分版本号展开成 { gte, lt } 区间 */
function expandPartial(ref) {
  const parts = String(ref).split('.').map(Number);
  if (parts.length === 1) return { gte: `${parts[0]}.0.0`, lt: `${parts[0] + 1}.0.0` };
  if (parts.length === 2) return { gte: `${parts[0]}.${parts[1]}.0`, lt: `${parts[0]}.${parts[1] + 1}.0` };
  return { gte: `${parts[0]}.${parts[1]}.${parts[2]}`, lt: `${parts[0] + 1}.0.0` };
}

/** 补全为完整三段版本号 */
function padVersion(ref) {
  const parts = String(ref).replace(/^v/i, '').split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  return parts.join('.');
}

function parseComparator(token) {
  // → { pred(v) } or null if unsupported
  const t = token.trim();
  if (!t || t === '*' || t === 'x' || t === 'X') return () => true;

  // caret / tilde
  if (t.startsWith('^')) {
    const ref = t.slice(1);
    if (!/^\d+(\.\d+)?(\.\d+)?$/.test(ref)) return null;
    const major = Number(ref.split('.')[0]);
    const gte = padVersion(ref);
    return (v) => satisfiesComparator(v, '>=', gte) && satisfiesComparator(v, '<', `${major + 1}.0.0`);
  }
  if (t.startsWith('~')) {
    const ref = t.slice(1);
    if (!/^\d+(\.\d+)?(\.\d+)?$/.test(ref)) return null;
    const p = padVersion(ref).split('.').map(Number);
    const gte = padVersion(ref);
    return (v) => satisfiesComparator(v, '>=', gte) && satisfiesComparator(v, '<', `${p[0]}.${p[1] + 1}.0`);
  }
  // partial with x, e.g. 1.2.x
  const xm = t.match(/^(\d+)\.(\d+)\.x$/i);
  if (xm) {
    return (v) => satisfiesComparator(v, '>=', `${xm[1]}.${xm[2]}.0`) && satisfiesComparator(v, '<', `${xm[1]}.${+xm[2] + 1}.0`);
  }
  const xm1 = t.match(/^(\d+)\.x$/i);
  if (xm1) {
    return (v) => satisfiesComparator(v, '>=', `${xm1[1]}.0.0`) && satisfiesComparator(v, '<', `${+xm1[1] + 1}.0.0`);
  }
  // operator (optional) + version (partial allowed)
  const m = t.match(/^(>=|<=|>|<|=)?\s*(v?\d+(?:\.\d+){0,2})$/);
  if (m) {
    const op = m[1] || '=';
    const raw = m[2].replace(/^v/i, '');
    if (op === '=') {
      // 无操作符或显式 '='：完整版本→精确；部分版本→区间
      if (raw.split('.').length === 3) {
        return (v) => satisfiesComparator(v, '=', raw);
      }
      const r = expandPartial(raw);
      return (v) => satisfiesComparator(v, '>=', r.gte) && satisfiesComparator(v, '<', r.lt);
    }
    return (v) => satisfiesComparator(v, op, padVersion(raw));
  }
  return null; // unsupported token
}

/**
 * 判断 version 是否满足 range。
 * @returns {boolean}
 */
function satisfies(version, range) {
  if (version == null) return false;
  const rangeStr = String(range == null ? '*' : range).trim();
  if (!rangeStr || rangeStr === '*' || rangeStr === 'x' || rangeStr === 'X') return true;

  if (rangeStr.includes('||')) {
    return rangeStr.split('||').some((part) => satisfies(version, part));
  }

  const tokens = rangeStr.split(/\s+/).filter(Boolean);
  const preds = [];
  for (const t of tokens) {
    const pred = parseComparator(t);
    if (!pred) {
      // 无法解析的范围 → 保守拒绝（安全协议：解析不了就当不兼容）
      return false;
    }
    preds.push(pred);
  }
  return preds.every((p) => p(version));
}

/**
 * 校验插件清单 (manifest)。
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object') return { ok: false, errors: ['清单缺失或不是对象'] };
  if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(m.id)) {
    errors.push('id 必须匹配 /^[a-z0-9][a-z0-9._-]{0,63}$/i');
  }
  if (typeof m.name !== 'string' || !m.name.trim()) errors.push('缺少 name');
  if (typeof m.version !== 'string' || !parseVersion(m.version)) errors.push('version 必须是 semver（如 1.2.3）');
  if (m.kind !== undefined && !['plugin', 'skill'].includes(m.kind)) errors.push('kind 只能是 plugin 或 skill');
  if (m.main !== undefined && typeof m.main !== 'string') errors.push('main 必须是字符串路径');
  if (m.inject !== undefined && typeof m.inject !== 'string') errors.push('inject 必须是字符串路径');
  if (m.compat !== undefined && (typeof m.compat !== 'object' || m.compat === null || Array.isArray(m.compat))) {
    errors.push('compat 必须是对象，如 { os: ["win32"], electron: ">=28" }');
  }
  if (m.compat && typeof m.compat === 'object') {
    for (const k of ['os', 'arch']) {
      if (m.compat[k] !== undefined && (!Array.isArray(m.compat[k]) || m.compat[k].length === 0)) {
        errors.push(`compat.${k} 必须是非空数组`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 兼容性检查（安全协议核心）。
 * @param {object} manifest 插件清单
 * @param {object} env { os, arch, electron, dsh, node, app }
 * @returns {{ok: boolean, errors: string[], env: object}}
 */
function checkCompat(manifest, env = {}) {
  const e = {
    os: process.platform,
    arch: process.arch,
    electron: null,
    dsh: null,
    node: process.versions ? process.versions.node : null,
    app: null,
    ...env,
  };
  const compat = (manifest && manifest.compat) || {};
  const errors = [];

  if (compat.os && Array.isArray(compat.os) && compat.os.length) {
    if (!compat.os.includes(e.os)) {
      errors.push(`操作系统不兼容：插件需要 ${compat.os.join('/')}，当前为 ${e.os}`);
    }
  }
  if (compat.arch && Array.isArray(compat.arch) && compat.arch.length) {
    if (!compat.arch.includes(e.arch)) {
      errors.push(`CPU 架构不兼容：插件需要 ${compat.arch.join('/')}，当前为 ${e.arch}`);
    }
  }
  for (const key of ['electron', 'dsh', 'node', 'app']) {
    const range = compat[key];
    if (range === undefined) continue;
    if (e[key] == null) {
      // 无法确定当前版本 → 按不兼容处理（宁可不装，不可装错）
      errors.push(`无法确定当前 ${key} 版本，无法验证 ${range} 约束，按不兼容处理`);
      continue;
    }
    if (!satisfies(e[key], range)) {
      errors.push(`${key} 版本不兼容：插件需要 ${range}，当前为 ${e[key]}`);
    }
  }
  return { ok: errors.length === 0, errors, env: e };
}

module.exports = {
  parseVersion,
  compareVersions,
  satisfies,
  validateManifest,
  checkCompat,
};