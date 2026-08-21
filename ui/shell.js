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
  console.log('[wallpaper:render] state=' + JSON.stringify(wpState ? { active: wpState.active, type: wpState.type, mode: wpState.mode, source: wpState.source ? 'yes' : 'no' } : null) + ' visible=' + visible);
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
    // 目录壁纸：自动轮换（视频+图片都支持；每次只加载一个媒体，内存可控）
    const scan = await api.invoke('wallpaper:files', wpState.source).catch(() => ({ videos: [], images: [] }));
    console.log('[wallpaper:render] scan=' + JSON.stringify({ images: (scan.images || []).length, videos: (scan.videos || []).length }));
    wpFiles = [...(scan.images || []), ...(scan.videos || [])];
    if (!wpFiles.length) {
      bg.className = 'bg off';
      return;
    }
    const box = document.createElement('div');
    box.id = 'wp-media-box';
    bg.appendChild(box);
    const interval = Math.max(5, Number(wpState.interval) || 60) * 1000;
    let wpIndex = 0;
    const show = (i) => {
      if (!wpFiles.length) return;
      wpIndex = ((i % wpFiles.length) + wpFiles.length) % wpFiles.length;
      const u = wpFiles[wpIndex];
      box.innerHTML = ''; // 每次只保留一个媒体（旧 video/img 释放）
      // 新媒体就绪后立即采样亮度 → 文字颜色快速匹配（避免轮换后短暂不清晰）
      const onReady = () => {
        wpBrightStable = 0;
        wpBrightLast = null;
        setTimeout(sampleWallpaperBrightness, 60);
      };
      if (/\.(jpg|jpeg|png|webp|bmp)([?#]|$)/i.test(u)) {
        const img = document.createElement('img');
        img.src = toFileUrl(u);
        img.onload = onReady;
        box.appendChild(img);
      } else {
        const v = document.createElement('video');
        v.src = toFileUrl(u);
        v.autoplay = true;
        v.muted = true;
        v.loop = true;
        v.playsInline = true;
        v.onloadeddata = onReady;
        box.appendChild(v);
      }
    };
    show(0);
    showWpNext = () => show(wpIndex + 1);
    wpRotateTimer = setInterval(showWpNext, interval);
  }
  const shade = document.createElement('div');
  shade.className = 'shade';
  bg.appendChild(shade);
  // 透明度：壁纸媒体不透明度 = slider/100（0=壁纸完全淡出，100=全显示）
  // 遮罩固定 rgba(10,12,18,.42) 保证文字可读；slider 越低壁纸越淡，变化直观
  const op = Math.max(0, Math.min(100, Number(wpState?.opacity ?? 100)));
  bg.querySelectorAll('video, img, iframe, #wp-media-box').forEach((el) => {
    el.style.opacity = String(op / 100);
  });
  // 透明度极低(<15)：壁纸几乎不可见 → 背景显示浅色渐变底（类似 DSH 白底），
  // 文字强制深色（亮度采样 dark=true），保证可读
  bg.classList.toggle('dim', op < 15);
  if (op < 15) {
    bg.style.background = 'linear-gradient(160deg, #f4f6fb, #e2e6f0)';
    // 强制通知主进程：深色文字
    wpBrightStable = 0;
    wpBrightLast = null;
    api.invoke('wallpaper:brightness', { dark: false });
  } else {
    bg.style.background = '';
  }
  startBrightnessSampling();
}

/** 目录模式手动切换下一张壁纸（侧边栏按钮调用） */
function nextWallpaper() {
  if (wpState?.type !== 'dir' || !wpFiles.length) {
    toast('仅目录轮换模式支持手动切换（请在壁纸页选择图片目录）', 'err');
    return;
  }
  wpRotateTimer && clearInterval(wpRotateTimer);
  const interval = Math.max(5, Number(wpState.interval) || 60) * 1000;
  // 直接显示下一张
  showWpNext && showWpNext();
  toast('已切换下一张壁纸', 'ok');
  wpRotateTimer = setInterval(showWpNext, interval);
}

/** 由 dir 分支注入的"切下一张"回调（避免全局变量耦合） */
let showWpNext = null;

let wpBrightTimer = null;
let wpBrightStable = 0;
let wpBrightLast = null;

/**
 * 采样当前壁纸平均亮度 → 通知主进程切换 DSH 文字颜色。
 * 防抖：连续 2 次采样结果一致才切换，避免轮换瞬间/视频变化导致文字颜色抖动。
 * 媒体未就绪（readyState<2）时返回 false，调用方可稍后重试。
 */
function sampleWallpaperBrightness() {
  // 透明度极低：背景为浅色底 → 强制深色文字（dark=false），不再按壁纸亮度采样
  const op = Math.max(0, Math.min(100, Number(wpState?.opacity ?? 100)));
  if (op < 15) {
    if (wpBrightLast !== false) {
      wpBrightLast = false;
      wpBrightStable = 0;
      api.invoke('wallpaper:brightness', { dark: false });
    }
    return true;
  }
  const media = document.querySelector('#bg video, #bg img, #wp-media-box video, #wp-media-box img');
  if (!media || media.readyState < 2) return false;
  try {
    const c = document.createElement('canvas');
    c.width = 24;
    c.height = 14;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    ctx.drawImage(media, 0, 0, 24, 14);
    const d = ctx.getImageData(0, 0, 24, 14).data;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 16) {
      sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
      n++;
    }
    if (!n) return false;
    // 默认保持白色文字（用户需求）；只有壁纸接近纯白（平均亮度 > 210）才切深色文字
    const dark = sum / n > 210;
    if (dark === wpBrightLast) {
      wpBrightStable++;
    } else {
      wpBrightStable = 0;
      wpBrightLast = dark;
    }
    // 连续 2 次一致（含首次）才通知主进程切换
    if (wpBrightStable >= 1) {
      api.invoke('wallpaper:brightness', { dark });
    }
    return true;
  } catch (e) {
    return false;
  }
}

function startBrightnessSampling() {
  if (wpBrightTimer) return;
  sampleWallpaperBrightness();
  wpBrightTimer = setInterval(() => {
    // 媒体未就绪（如轮换加载中）→ 稍后重试（快速重试 3 次）
    if (!sampleWallpaperBrightness()) {
      let retries = 0;
      const t = setInterval(() => {
        if (sampleWallpaperBrightness() || ++retries >= 3) clearInterval(t);
      }, 600);
    }
  }, 5000);
}

function stopBrightnessSampling() {
  if (wpBrightTimer) {
    clearInterval(wpBrightTimer);
    wpBrightTimer = null;
  }
  wpBrightStable = 0;
  wpBrightLast = null;
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
  // —— 左侧栏折叠/展开 ——
  const sideToggleBtn = $('#btn-side-toggle');
  if (sideToggleBtn) {
    sideToggleBtn.onclick = async () => {
      const collapsed = document.body.classList.toggle('side-collapsed');
      const fold = $('.btn-side-toggle .ic-fold');
      const unfold = $('.btn-side-toggle .ic-unfold');
      if (fold) fold.style.display = collapsed ? 'none' : '';
      if (unfold) unfold.style.display = collapsed ? '' : 'none';
      api.invoke('ui:settings:set', { sidebarCollapsed: collapsed }).catch(() => {});
    };
    // 启动时恢复上次的折叠状态
    const ui = await api.invoke('ui:settings:get').catch(() => ({}));
    if (ui.sidebarCollapsed) {
      document.body.classList.add('side-collapsed');
      const fold = $('.btn-side-toggle .ic-fold');
      const unfold = $('.btn-side-toggle .ic-unfold');
      if (fold) fold.style.display = 'none';
      if (unfold) unfold.style.display = '';
    }
  }
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
    const op = Math.max(0, Math.min(100, Number(s.settings.opacity ?? 100)));
    const el = $('#wp-opacity');
    const val = $('#wp-opacity-val');
    if (el) el.value = String(op);
    if (val) val.textContent = String(op);
  }
}

init();