'use strict';
/**
 * shell.js — 客户端主窗口逻辑
 * 左侧功能边栏 + 右侧壁纸背景层 + DSH 内嵌视图。
 * 通过 window.dshApi 与主进程通信。
 */
const api = window.dshApi;
const $ = (sel) => document.querySelector(sel);

let wpState = null; // { enabled, type, source, mode }

function setSwitch(btn, on) {
  btn.classList.toggle('on', !!on);
  btn.title = on ? '点击关闭' : '点击开启';
}

function toast(msg, type = 'ok') {
  const el = $('#status-txt');
  el.textContent = msg;
  el.style.color = type === 'err' ? 'var(--red)' : 'var(--green)';
  setTimeout(() => {
    el.style.color = '';
    refreshDshStatus();
  }, 3500);
}

async function refreshDshStatus() {
  const s = await api.invoke('dsh:status').catch(() => ({ connected: false, url: '' }));
  $('#status-dot').classList.toggle('on', s.connected);
  $('#status-txt').textContent = s.connected ? 'DSH 已连接' : 'DSH 未连接';
  $('#offline-url').textContent = s.url || '';
  $('#offline').classList.toggle('show', !s.connected);
  $('#dsh').classList.toggle('hidden', !s.connected);
}

async function refreshHandoffPreview() {
  const h = await api.invoke('memory:handoff').catch(() => null);
  const box = $('#handoff-box');
  if (h && h.summary) {
    box.style.display = 'block';
    const lines = h.summary.split('\n').slice(0, 6).join('\n');
    box.innerHTML = '<b>最近交接摘要</b>\n' + escapeHtml(lines.length > 240 ? lines.slice(0, 240) + '…' : lines);
  } else {
    box.style.display = 'none';
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 更新最大化按钮图标（最大化时显示还原） */
function updateMaxIcon(maximized) {
  const ic = $('#ic-max');
  if (!ic) return;
  ic.innerHTML = maximized
    ? '<rect x="3" y="3" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M1 7 L1 1 L7 1" fill="none" stroke="currentColor" stroke-width="1.2"/>'
    : '<rect x="1" y="1" width="10" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/>';
}

/** 渲染壁纸背景层（客户端窗口背景模式） */
let wpRotateTimer = null;
let wpFiles = [];

/** Windows 本地路径 → file:// URL（video/img 的 src 需要 URL，不能直接塞路径） */
function toFileUrl(p) {
  if (/^https?:|^file:|^data:/i.test(String(p))) return String(p);
  return 'file:///' + encodeURI(String(p).replace(/\\/g, '/')).replace(/#/g, '%23');
}

async function renderWallpaper() {
  const bg = $('#bg');
  bg.innerHTML = '';
  clearInterval(wpRotateTimer);
  wpRotateTimer = null;
  wpFiles = [];

  const on = wpState && wpState.active && (wpState.type === 'video' || wpState.type === 'web' || wpState.type === 'dir') && wpState.source;
  const isWindowMode = !wpState || wpState.mode !== 'desktop'; // window 模式才在客户端渲染
  const visible = on && isWindowMode;
  $('#wp-badge').classList.toggle('show', !!visible);
  setSwitch($('#sw-wallpaper'), !!wpState?.active);

  if (!visible) {
    bg.className = 'bg off';
    const shade = document.createElement('div');
    shade.className = 'shade';
    bg.appendChild(shade);
    stopBrightnessSampling();
    return;
  }
  bg.className = 'bg on';

  if (wpState.type === 'video') {
    const v = document.createElement('video');
    v.src = toFileUrl(wpState.source);
    v.autoplay = true;
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    bg.appendChild(v);
  } else if (wpState.type === 'web') {
    const f = document.createElement('iframe');
    f.src = wpState.source;
    f.allow = 'autoplay';
    bg.appendChild(f);
  } else if (wpState.type === 'dir') {
    // 目录壁纸：自动轮换
    const scan = await api.invoke('wallpaper:files', wpState.source).catch(() => ({ videos: [], images: [] }));
    wpFiles = [...(scan.images || []), ...(scan.videos || [])];
    if (!wpFiles.length) {
      bg.className = 'bg off';
      return;
    }
    const box = document.createElement('div');
    box.id = 'wp-media-box';
    bg.appendChild(box);
    const interval = Math.max(5, Number(wpState.interval) || 60) * 1000;
    const show = (i) => {
      const u = wpFiles[i % wpFiles.length];
      box.innerHTML = '';
      if (/\.(jpg|jpeg|png|webp|bmp)([?#]|$)/i.test(u)) {
        const img = document.createElement('img');
        img.src = toFileUrl(u);
        box.appendChild(img);
      } else {
        const v = document.createElement('video');
        v.src = toFileUrl(u);
        v.autoplay = true;
        v.muted = true;
        v.loop = true;
        v.playsInline = true;
        box.appendChild(v);
      }
    };
    show(0);
    let i = 1;
    wpRotateTimer = setInterval(() => {
      show(i);
      i = (i + 1) % wpFiles.length;
    }, interval);
  }
  const shade = document.createElement('div');
  shade.className = 'shade';
  const opacity = Math.max(0, Math.min(90, Number(wpState?.opacity ?? 55)));
  shade.style.opacity = String(opacity / 100);
  if (opacity < 8) shade.style.background = 'rgba(10,12,18,0)'; // 接近透明遮罩
  bg.appendChild(shade);
  startBrightnessSampling();
}

let wpBrightTimer = null;

/** 周期采样壁纸平均亮度 → 通知主进程切换 DSH 文字颜色（亮壁纸深字/暗壁纸浅字） */
function startBrightnessSampling() {
  if (wpBrightTimer) return;
  const sample = () => {
    const media = document.querySelector('#bg video, #bg img, #wp-media-box video, #wp-media-box img');
    if (!media || media.readyState < 2) return;
    try {
      const c = document.createElement('canvas');
      c.width = 48;
      c.height = 27;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(media, 0, 0, 48, 27);
      const d = ctx.getImageData(0, 0, 48, 27).data;
      let sum = 0;
      let n = 0;
      for (let i = 0; i < d.length; i += 16) {
        sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
        n++;
      }
      if (!n) return;
      api.invoke('wallpaper:brightness', { dark: sum / n < 128 });
    } catch (e) {}
  };
  sample();
  wpBrightTimer = setInterval(sample, 3000);
}

function stopBrightnessSampling() {
  if (wpBrightTimer) {
    clearInterval(wpBrightTimer);
    wpBrightTimer = null;
  }
}

/** 预览/确认壁纸背景：会话框始终保留，壁纸作为会话背景直接可见 */
function previewWallpaper() {  if (!wpState || !wpState.active) {
    toast('壁纸未开启，请先在 壁纸 页设置来源', 'err');
    return;
  }
  if (wpState.mode === 'desktop') {
    toast('当前为系统桌面壁纸模式，客户端内不显示背景', 'err');
    return;
  }
  toast('🎨 壁纸已是会话背景（对话内容正常显示在壁纸上）', 'ok');
}

async function init() {
  const info = await api.invoke('app:info');
  $('#ver').textContent = 'v' + info.appVersion;

  document.querySelectorAll('.nav button[data-tab]').forEach((b) => {
    b.onclick = () => api.invoke('settings:open', b.dataset.tab);
  });

  $('#btn-summary').onclick = async () => {
    const r = await api.invoke('memory:summary', 'manual');
    r.ok ? toast('交接摘要已生成 ✅') : toast('生成失败: ' + r.error, 'err');
    await refreshHandoffPreview();
  };
  $('#btn-inject').onclick = async () => {
    const r = await api.invoke('memory:inject-handoff');
    r.ok ? toast('已注入到对话框，请检查后发送 ✅') : toast(r.error, 'err');
  };
  $('#btn-preview-wp').onclick = previewWallpaper;
  $('#btn-retry').onclick = () => api.invoke('app:reload-dsh');

  const swMem = $('#sw-memory');
  const swWp = $('#sw-wallpaper');
  setSwitch(swMem, info.builtins.memoryPlugin);
  setSwitch(swWp, info.builtins.wallpaperPlugin);
  swMem.onclick = async () => {
    const next = !swMem.classList.contains('on');
    await api.invoke('plugins:toggle', 'memory-plugin', next);
    setSwitch(swMem, next);
    toast(next ? '上下文记忆已开启' : '上下文记忆已关闭');
  };
  swWp.onclick = async () => {
    const next = !swWp.classList.contains('on');
    await api.invoke('plugins:toggle', 'wallpaper-plugin', next);
    setSwitch(swWp, next);
    toast(next ? '客户端壁纸已开启（到壁纸页设置来源）' : '客户端壁纸已关闭');
    await refreshWallpaperState();
  };

  // 背景透明度调节
  const wpOpacity = $('#wp-opacity');
  const wpOpacityVal = $('#wp-opacity-val');
  wpOpacity.oninput = async () => {
    const v = Number(wpOpacity.value);
    wpOpacityVal.textContent = String(v);
    await api.invoke('wallpaper:settings:set', { opacity: v });
  };

  $('#btn-settings').onclick = () => api.invoke('settings:open', null);
  $('#lnk-github').onclick = () => api.invoke('app:open-external', 'https://github.com/zong-technology/dsh-desktop');
  $('#lnk-quit').onclick = () => api.invoke('app:quit');

  // —— 标题栏窗口控制 ——
  $('#btn-min').onclick = () => api.invoke('window:minimize');
  $('#btn-max').onclick = async () => {
    const r = await api.invoke('window:maximize-toggle');
    updateMaxIcon(r.maximized);
  };
  $('#btn-close').onclick = () => api.invoke('window:close');
  const wst = await api.invoke('window:state').catch(() => ({ maximized: false }));
  updateMaxIcon(wst.maximized);
  api.on('window:state', (s) => updateMaxIcon(s.maximized));

  api.on('dsh:status', () => refreshDshStatus());
  api.on('memory:handoff-updated', () => refreshHandoffPreview());
  api.on('wallpaper:changed', async () => {
    await refreshWallpaperState();
    renderWallpaper();
  });

  await refreshWallpaperState();
  renderWallpaper();
  await refreshDshStatus();
  await refreshHandoffPreview();
  setInterval(async () => {
    await refreshDshStatus();
    await refreshHandoffPreview();
  }, 20000);
}

async function refreshWallpaperState() {
  const s = await api.invoke('wallpaper:state').catch(() => null);
  if (s) {
    wpState = { ...s.settings, active: s.active };
    const op = Math.max(0, Math.min(90, Number(s.settings.opacity ?? 55)));
    const el = $('#wp-opacity');
    const val = $('#wp-opacity-val');
    if (el) el.value = String(op);
    if (val) val.textContent = String(op);
  }
}

init();