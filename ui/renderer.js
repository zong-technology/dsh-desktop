'use strict';
/**
 * renderer.js — 设置窗口渲染逻辑（无框架、无构建）
 * 通信通过 window.dshApi（见 src/preload.js）。
 */

const api = window.dshApi;
const $ = (sel) => document.querySelector(sel);

let plugins = [];
let recommended = { items: [] };
let info = null;
let memSettings = null;

// ---------- 基础 ----------

let toastTimer = null;
function toast(msg, type = 'ok') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = type), 4000);
}

function tab(name) {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
}

function switchState(row, enabled, onToggle) {
  const btn = row.querySelector('.switch');
  btn.classList.toggle('on', !!enabled);
  btn.title = enabled ? '点击关闭' : '点击开启';
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await api.invoke('plugins:toggle', row.dataset.id, !enabled);
      enabled = !enabled;
      btn.classList.toggle('on', enabled);
      toast(enabled ? '已启用' : '已停用', 'ok');
      onToggle && onToggle(enabled);
    } catch (e) {
      toast('操作失败: ' + e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  };
}

// ---------- 插件 Tab ----------

async function renderPlugins() {
  plugins = await api.invoke('plugins:list');
  const container = $('#plugin-list');
  container.innerHTML = '';

  const builtinRows = [
    { id: 'memory-plugin', name: '上下文记忆（内置）', desc: '接近上下文上限时自动简洁总结并交接给下一个会话', kind: 'builtin', state: info.builtins.memoryPlugin },
    { id: 'wallpaper-plugin', name: '动态壁纸（内置）', desc: '视频 / 网页壁纸，挂载到桌面层，类似 Wallpaper Engine', kind: 'builtin', state: info.builtins.wallpaperPlugin },
  ];

  const all = [
    ...builtinRows.map((b) => ({ id: b.id, manifest: { name: b.name, version: '内置', description: b.desc, kind: 'plugin' }, enabled: b.state, builtin: true })),
    ...plugins,
  ];

  if (!all.length) {
    container.innerHTML = '<div class="empty">暂无插件</div>';
    return;
  }

  for (const p of all) {
    const m = p.manifest;
    const row = document.createElement('div');
    row.className = 'prow';
    row.dataset.id = p.id;
    const kindTag = p.builtin ? '<span class="tag">内置</span>' : `<span class="tag">${m.kind || 'plugin'}</span>`;
    const meta = [kindTag, m.compat?.os ? `<span class="tag">OS: ${m.compat.os.join('/')}</span>` : '', m.compat?.electron ? `<span class="tag">Electron ${m.compat.electron}</span>` : ''].join('');
    row.innerHTML = `
      <div class="pinfo">
        <div class="pname">${esc(m.name)} <span class="ver">v${esc(m.version)}</span></div>
        <div class="pdesc">${esc(m.description || '')}</div>
        <div class="pmeta">${meta}</div>
      </div>
      <div class="pactions">
        <button class="switch ${p.enabled ? 'on' : ''}" title=""></button>
        ${p.builtin ? '' : '<button class="danger" data-uninstall="1">删除</button>'}
      </div>`;
    switchState(row, p.enabled, null);
    const un = row.querySelector('[data-uninstall]');
    if (un) {
      un.onclick = async () => {
        if (!confirm(`确定卸载插件「${m.name}」？`)) return;
        const r = await api.invoke('plugins:uninstall', p.id);
        if (r.ok) {
          toast('已卸载', 'ok');
          await renderPlugins();
        } else {
          toast('卸载失败: ' + r.error, 'err');
        }
      };
    }
    container.appendChild(row);
  }
  $('#plugin-count').textContent = all.length;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 推荐 Tab ----------

let recFilter = { q: '', kind: 'all', src: 'all', state: 'all' };

async function renderRecommended() {
  const r = await api.invoke('registry:recommended');
  recommended = r;
  $('#rec-source').textContent = r.source === 'remote' ? 'GitHub' : '本地';
  $('#rec-source').className = 'badge ' + (r.source === 'remote' ? 'green' : '');

  const container = $('#rec-list');
  container.innerHTML = '';
  const all = r.items || [];
  $('#rec-count').textContent = `${all.length} 个`;

  // —— 过滤 ——
  const q = recFilter.q.trim().toLowerCase();
  const items = all.filter((item) => {
    if (recFilter.kind !== 'all') {
      const k = item.builtin ? 'builtin' : item.kind === 'skill' ? 'skill' : item.kind === 'dsh-plugin' ? 'dsh-plugin' : 'plugin';
      if (k !== recFilter.kind) return false;
    }
    if (recFilter.src !== 'all') {
      const src = item.marketSource === 'github-market' ? 'github-market'
        : item.builtin ? 'local'
        : item.source && item.source.github ? 'github'
        : item.source && item.source.local ? 'local'
        : 'local';
      if (src !== recFilter.src) return false;
    }
    if (recFilter.state !== 'all') {
      const installed = plugins.find((p) => p.id === item.id);
      const isInst = !!installed || !!item.builtin;
      if (recFilter.state === 'installed' && !isInst) return false;
      if (recFilter.state === 'notinstalled' && isInst) return false;
    }
    if (q) {
      const hay = `${item.name} ${item.description || ''} ${(item.tags || []).join(' ')} ${item.author || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (!items.length) {
    container.innerHTML = '<div class="empty">没有符合条件的插件，换个筛选试试</div>';
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'rec-grid';

  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'rec-card';
    const kindCls = item.builtin ? 'builtin' : item.kind === 'skill' ? 'skill' : item.kind === 'dsh-plugin' ? 'dsh' : 'plugin';
    const kindLabel = item.builtin ? '内置' : item.kind === 'skill' ? 'Skill' : item.kind === 'dsh-plugin' ? 'DSH 插件' : '插件';
    const srcLabel = item.marketSource === 'github-market' ? 'GitHub 市场'
      : item.builtin ? '系统内置'
      : item.source && item.source.github ? '官方仓库'
      : item.source && item.source.local ? '本地包'
      : item.kind === 'skill' ? '官方 Skill'
      : '远程';
    const srcCls = item.marketSource === 'github-market' ? 'green' : item.source && item.source.github ? 'green' : item.builtin ? 'blue' : '';
    const verLabel = item.version && item.version !== 'builtin' ? item.version : '';
    const installed = plugins.find((p) => p.id === item.id);
    const enabled = installed ? installed.enabled : item.builtin ? (item.id === 'memory-plugin' ? info.builtins.memoryPlugin : info.builtins.wallpaperPlugin) : !!item.enabledState;
    // 生成一键安装 spec：source.github → "owner/repo[:子目录]"；source.local → "local:路径"
    const installSpec = item.installSpec
      || (item.source && item.source.github)
      || (item.source && item.source.local ? 'local:' + item.source.local : null);

    let actionHtml = '';
    if (item.kind === 'skill') {
      actionHtml = `
        <button class="switch ${enabled ? 'on' : ''}" title="启用/停用"></button>
        <button data-copy-prompt>复制提示词</button>`;
    } else if (item.kind === 'dsh-plugin') {
      actionHtml = `
        <button data-copy-cmd>📋 复制安装命令</button>
        <button data-open-gh>打开 GitHub</button>`;
    } else if (installed) {
      actionHtml = `<button class="switch ${enabled ? 'on' : ''}" title="启用/停用"></button>`;
    } else if (installSpec) {
      actionHtml = `<button class="primary" data-install-spec="${esc(installSpec)}">一键安装</button>`;
    } else {
      actionHtml = `<span class="badge">来源待配置</span>`;
    }

    card.innerHTML = `
      <div class="rname">${esc(item.name)} <span class="kind ${kindCls}">${kindLabel}</span>
        <span class="badge ${srcCls}">${srcLabel}</span>${verLabel ? `<span class="badge">v${esc(verLabel)}</span>` : ''}</div>
      <div class="rdesc">${esc(item.description || '')}</div>
      <div class="ract">${actionHtml}</div>`;
    card.dataset.id = String(item.id || '');

    const sw = card.querySelector('.switch');
    if (sw) switchState(card, enabled, null);

    const cp = card.querySelector('[data-copy-prompt]');
    if (cp) {
      cp.onclick = async () => {
        await api.invoke('app:copy', item.prompt || '');
        toast('提示词已复制到剪贴板', 'ok');
      };
    }
    const cc = card.querySelector('[data-copy-cmd]');
    if (cc) {
      cc.onclick = async () => {
        await api.invoke('app:copy', item.installCmd || '');
        toast('安装命令已复制：在终端粘贴执行，然后重启 DSH', 'ok');
      };
    }
    const og = card.querySelector('[data-open-gh]');
    if (og) {
      og.onclick = () => api.invoke('app:open-external', item.github || 'https://github.com');
    }
    const inst = card.querySelector('[data-install-spec]');
    if (inst) {
      inst.onclick = async () => {
        const spec = inst.dataset.installSpec;
        if (spec.startsWith('local:')) {
          const r2 = await api.invoke('plugins:install', spec);
          if (r2.ok) { toast('安装成功（已通过兼容检查与测试）', 'ok'); await refreshAll(); }
          else toast('安装失败，已自动回滚: ' + r2.error, 'err');
        } else {
          $('#install-spec').value = spec;
          tab('plugins');
          await doInstall(spec);
        }
      };
    }
    grid.appendChild(card);
  }
  container.appendChild(grid);

  // 筛选控件事件（只绑一次）
  if (!renderRecommended.bound) {
    renderRecommended.bound = true;
    $('#rec-search').oninput = () => {
      recFilter.q = $('#rec-search').value;
      renderRecommended();
    };
    for (const rowSel of ['#rec-filter-kind', '#rec-filter-src', '#rec-filter-state']) {
      const row = document.querySelector(rowSel);
      const key = rowSel.includes('kind') ? 'kind' : rowSel.includes('src') ? 'src' : 'state';
      row.querySelectorAll('.chip').forEach((chip) => {
        chip.onclick = () => {
          row.querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
          chip.classList.add('on');
          recFilter[key] = chip.dataset.v;
          renderRecommended();
        };
      });
    }
  }
}

// ---------- 记忆 Tab ----------

async function renderMemory() {
  memSettings = await api.invoke('memory:settings:get');
  $('#memory-enable').classList.toggle('on', memSettings.enabled);
  $('#memory-enable').onclick = async () => {
    const v = !memSettings.enabled;
    await api.invoke('memory:settings:set', { enabled: v });
    memSettings.enabled = v;
    $('#memory-enable').classList.toggle('on', v);
    toast(v ? '上下文记忆已开启' : '上下文记忆已关闭', 'ok');
  };
  $('#mem-limit').value = memSettings.contextLimit;
  $('#mem-threshold').value = memSettings.summarizeAt;
  $('#mem-apikey').value = memSettings.deepseekApiKey || '';
  $('#mem-autoinject').value = memSettings.autoInjectHandoff ? 'auto' : '';

  for (const [sel, key] of [['#mem-limit', 'contextLimit'], ['#mem-threshold', 'summarizeAt'], ['#mem-apikey', 'deepseekApiKey'], ['#mem-autoinject', 'autoInjectHandoff']]) {
    $(sel).onchange = async () => {
      const el = $(sel);
      let v = el.value;
      if (key === 'contextLimit') v = Math.max(4000, parseInt(v, 10) || 128000);
      if (key === 'summarizeAt') v = Math.min(1, Math.max(0.1, parseFloat(v) || 0.7));
      if (key === 'autoInjectHandoff') v = el.value.trim() === 'auto';
      await api.invoke('memory:settings:set', { [key]: v });
      toast('记忆设置已保存', 'ok');
    };
  }

  await refreshHandoff();
}

async function refreshHandoff() {
  const handoff = await api.invoke('memory:handoff');
  const pre = $('#handoff-preview');
  if (handoff) {
    pre.textContent = handoff.summary + `\n\n———\n生成时间: ${handoff.at}\n模式: ${handoff.mode}\n来源: ${handoff.title}`;
    const metric = $('#mem-metric');
    metric.innerHTML = `
      <div class="m">上次生成: <b>${handoff.at || '-'}</b></div>
      <div class="m">模式: <b>${handoff.mode || '-'}</b></div>
      <div class="m">摘要约 <b>${handoff.estimateTokens || 0}</b> tokens</div>`;
  } else {
    pre.textContent = '（暂无交接摘要）';
    $('#mem-metric').innerHTML = '';
  }

  const convs = await api.invoke('memory:conversations');
  $('#conv-count').textContent = convs.length;
  const list = $('#conv-list');
  list.innerHTML = '';
  if (!convs.length) {
    list.innerHTML = '<div class="empty">暂无历史交接</div>';
    return;
  }
  for (const c of convs.slice(0, 10)) {
    const row = document.createElement('div');
    row.className = 'prow';
    row.innerHTML = `<div class="pinfo"><div class="pname">${esc(c.title || '会话')}</div><div class="pdesc">${esc((c.summary || '').slice(0, 80))}…</div></div>
      <span class="badge">${esc(c.at || '')}</span>`;
    list.appendChild(row);
  }
}

// ---------- 壁纸 Tab ----------

async function renderWallpaper() {
  const st = await api.invoke('wallpaper:state');
  const radioType = document.querySelector(`input[name="wp-type"][value="${st.settings.type || 'off'}"]`);
  if (radioType) radioType.checked = true;
  const radioMode = document.querySelector(`input[name="wp-mode"][value="${st.settings.mode || 'window'}"]`);
  if (radioMode) radioMode.checked = true;
  $('#wp-source').value = st.settings.source || '';
  $('#wp-interval').value = st.settings.interval || 60;
  const op = Math.max(0, Math.min(100, Number(st.settings.opacity ?? 100)));
  $('#wp-opacity').value = String(op);
  $('#wp-opacity-val').textContent = String(op);
  $('#wp-opacity').oninput = async () => {
    const v = Number($('#wp-opacity').value);
    $('#wp-opacity-val').textContent = String(v);
    await api.invoke('wallpaper:settings:set', { opacity: v });
  };

  const updateState = (st2) => {
    $('#wp-state').innerHTML = `
      <div class="m">状态: <b>${st2.active ? '运行中' : '未运行'}</b></div>
      <div class="m">模式: <b>${st2.settings.mode === 'desktop' ? '系统桌面壁纸' : '客户端背景（推荐）'}</b></div>
      <div class="m">类型: <b>${st2.settings.type || 'off'}</b></div>
      ${st2.supported ? '' : '<div class="m" style="color:var(--yellow)">非 Windows 环境不支持系统桌面模式</div>'}
      ${st2.settings.enabled ? `<div class="m">来源: <b>${esc(st2.settings.source || '')}</b></div>` : ''}`;
  };
  updateState(st);

  const apply = async () => {
    const type = document.querySelector('input[name="wp-type"]:checked')?.value || 'off';
    const mode = document.querySelector('input[name="wp-mode"]:checked')?.value || 'window';
    const source = $('#wp-source').value.trim();
    const interval = Math.max(5, Number($('#wp-interval').value) || 60);
    // 先保存模式与间隔
    await api.invoke('wallpaper:settings:set', { mode, interval });
    if (type === 'off') {
      const r = await api.invoke('wallpaper:stop');
      r.ok ? toast('壁纸已关闭', 'ok') : toast('关闭失败: ' + r.error, 'err');
      await renderWallpaper();
      return;
    }
    if (!source) { toast('请填写视频路径、网页 URL 或目录路径', 'err'); return; }
    let r;
    if (type === 'video') r = await api.invoke('wallpaper:start-video', source);
    else if (type === 'web') r = await api.invoke('wallpaper:start-web', source);
    else r = await api.invoke('wallpaper:start-dir', source);
    r.ok ? toast('壁纸已应用', 'ok') : toast('应用失败: ' + r.error, 'err');
    await renderWallpaper();
  };

  $('#btn-wp-apply').onclick = apply;
  $('#btn-pick-video').onclick = async () => {
    const p = await api.invoke('dialog:pick-video');
    if (p) $('#wp-source').value = p;
  };
  $('#btn-pick-dir').onclick = async () => {
    const p = await api.invoke('dialog:pick-dir');
    if (p) {
      $('#wp-source').value = p;
      document.querySelector('input[name="wp-type"][value="dir"]').checked = true;
    }
  };
}

// ---------- 关于 Tab ----------

async function renderAbout() {
  info = info || (await api.invoke('app:info'));
  $('#about-info').innerHTML = `
    DSH Desktop v${esc(info.appVersion)}<br>
    · DSH Web: <a class="link" id="lnk-dsh">${esc(info.dshUrl)}</a>（DSH ${esc(info.dshVersion)}）<br>
    · Electron ${esc(info.electron)} · Node ${esc(info.node)} · ${esc(info.os)}/${esc(info.arch)}<br>
    · 插件目录: <code>${esc(info.pluginsDir)}</code><br>
    · 记忆目录: <code>${esc(info.memoryDir)}</code>`;
  $('#lnk-dsh')?.addEventListener('click', () => window.open(info.dshUrl));
}

// ---------- 安装（含进度流程视图） ----------

const INSTALL_STEPS = [
  { key: 'resolve', label: '解析源' },
  { key: 'download', label: '下载' },
  { key: 'extract', label: '解压' },
  { key: 'manifest', label: '校验清单' },
  { key: 'compat', label: '兼容检查' },
  { key: 'copy', label: '复制安装' },
  { key: 'test', label: '运行测试' },
  { key: 'done', label: '完成' },
];
let stepState = {};
let stepLog = [];

function resetSteps() {
  stepState = {};
  stepLog = [];
  renderSteps();
}

function renderSteps() {
  const res = $('#install-result');
  const stepsHtml = INSTALL_STEPS.map((s) => {
    const st = stepState[s.key] || 'waiting';
    const mark = st === 'done' ? '✓' : st === 'doing' ? '⏳' : st === 'fail' ? '✗' : '·';
    return `<span class="step ${st}">${mark} ${s.label}</span>`;
  }).join('');
  const logHtml = stepLog.length
    ? `<div class="step-log">${stepLog.map((l) => `<span class="${l.kind}">${esc(l.text)}</span>`).join('\n')}</div>`
    : '';
  res.innerHTML = `<div class="steps">${stepsHtml}</div>${logHtml}`;
}

async function doInstall(spec) {
  const res = $('#install-result');
  res.className = 'result';
  resetSteps();
  stepLog.push({ kind: 'ok', text: `开始安装: ${spec}` });
  renderSteps();
  const r = await api.invoke('plugins:install', spec);
  if (r.ok) {
    stepLog.push({ kind: 'ok', text: `✅ 安装成功：${r.manifest.name} v${r.manifest.version}（兼容性检查 ✅ 测试 ✅）` });
    renderSteps();
    toast('安装成功（已通过兼容检查与测试）', 'ok');
    await refreshAll();
  } else {
    stepLog.push({ kind: 'err', text: `❌ 安装失败，已自动回滚删除。原因：${r.error}` });
    renderSteps();
    toast('安装失败，已自动回滚', 'err');
  }
}

async function refreshAll() {
  info = await api.invoke('app:info');
  await renderPlugins();
  await renderRecommended();
  await renderMemory();
  await renderWallpaper();
  await renderAbout();
}

// ---------- 初始化 ----------

async function init() {
  document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => tab(b.dataset.tab)));

  $('#btn-install').onclick = () => {
    const spec = $('#install-spec').value.trim();
    if (!spec) { toast('请输入安装源', 'err'); return; }
    doInstall(spec);
  };
  $('#install-spec').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btn-install').click();
  });

  $('#btn-summarize').onclick = async () => {
    const r = await api.invoke('memory:summary', 'manual');
    if (r.ok) { toast('交接摘要已生成', 'ok'); await refreshHandoff(); }
    else toast('生成失败: ' + r.error, 'err');
  };
  $('#btn-summarize-llm').onclick = async () => {
    const s = await api.invoke('memory:settings:get');
    if (!s.deepseekApiKey) { toast('请先配置 DeepSeek API Key', 'err'); return; }
    const r = await api.invoke('memory:summary', 'llm');
    if (r.ok && r.handoff?.mode === 'llm') { toast('LLM 交接摘要已生成', 'ok'); await refreshHandoff(); }
    else toast('LLM 总结不可用（已回退规则总结）', 'err');
  };
  $('#btn-copy-handoff').onclick = async () => {
    const h = await api.invoke('memory:handoff');
    if (!h) { toast('暂无交接摘要', 'err'); return; }
    await api.invoke('app:copy', h.summary);
    toast('已复制到剪贴板', 'ok');
  };
  $('#btn-inject-handoff').onclick = async () => {
    const r = await api.invoke('memory:inject-handoff');
    r.ok ? toast('已注入到 DSH 对话框，请检查后发送', 'ok') : toast('注入失败: ' + r.error, 'err');
  };
  $('#btn-import-session').onclick = async () => {
    toast('正在提取 DSH 页面会话文本…');
    const r = await api.invoke('memory:import-from-page');
    if (!r.ok) { toast('导入失败: ' + r.error, 'err'); return; }
    toast(`已导入 ${r.chars} 字符并生成交接摘要`, 'ok');
    await refreshHandoff();
  };

  $('#btn-open-github').onclick = () => api.invoke('app:open-external', 'https://github.com/zong-technology/dsh-desktop');
  $('#btn-reload-dsh').onclick = async () => {
    await api.invoke('app:reload-dsh');
    toast('DSH 页面已重新加载', 'ok');
  };
  $('#btn-open-data-dir').onclick = () => api.invoke('app:open-external', 'file:///' + (info?.pluginsDir || '').replace(/\\/g, '/').replace(/\/plugins$/, ''));

  api.on('memory:handoff-updated', () => refreshHandoff());
  api.on('nav-to', (t) => {
    if (t && document.querySelector(`nav button[data-tab="${t}"]`)) tab(t);
  });
  api.on('plugin:install-progress', (p) => {
    if (!p || !p.stage) return;
    // 更新步骤状态
    for (const s of INSTALL_STEPS) {
      const pos = INSTALL_STEPS.indexOf(s);
      const curPos = INSTALL_STEPS.findIndex((x) => x.key === p.stage);
      if (p.stage === 'fail') {
        if (pos < curPos) stepState[s.key] = 'done';
        else if (pos === curPos) stepState[s.key] = 'fail';
      } else if (curPos === pos) {
        stepState[s.key] = 'doing';
      } else if (curPos > pos) {
        stepState[s.key] = 'done';
      }
    }
    if (p.stage === 'fail') {
      stepLog.push({ kind: 'err', text: p.message || '安装失败' });
    } else {
      stepLog.push({ kind: 'ok', text: p.message || p.stage });
    }
    if (stepLog.length > 40) stepLog = stepLog.slice(-40);
    renderSteps();
  });

  await refreshAll();
}

init();