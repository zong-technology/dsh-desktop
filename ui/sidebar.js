'use strict';
/**
 * sidebar.js — 左侧功能边栏逻辑
 * 通过 window.dshApi 与主进程通信（同一 preload.js 桥）。
 */
const api = window.dshApi;
const $ = (sel) => document.querySelector(sel);

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
  $('#status-txt').textContent = s.connected ? 'DSH 已连接' : 'DSH 未连接（离线页）';
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

async function init() {
  // 版本
  const info = await api.invoke('app:info');
  $('#ver').textContent = 'v' + info.appVersion;

  // 导航：打开设置窗口并切换 tab
  document.querySelectorAll('nav button[data-tab]').forEach((b) => {
    b.onclick = () => api.invoke('settings:open', b.dataset.tab);
  });

  // 快捷操作
  $('#btn-summary').onclick = async () => {
    const r = await api.invoke('memory:summary', 'manual');
    r.ok ? toast('交接摘要已生成 ✅') : toast('生成失败: ' + r.error, 'err');
    await refreshHandoffPreview();
  };
  $('#btn-inject').onclick = async () => {
    const r = await api.invoke('memory:inject-handoff');
    r.ok ? toast('已注入到对话框，请检查后发送 ✅') : toast(r.error, 'err');
  };

  // 开关
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
    toast(next ? '动态壁纸已开启（到壁纸页设置来源）' : '动态壁纸已关闭');
  };

  $('#btn-settings').onclick = () => api.invoke('settings:open', null);
  $('#lnk-github').onclick = () => api.invoke('app:open-external', 'https://github.com/zong-technology/dsh-desktop');
  $('#lnk-quit').onclick = () => api.invoke('app:quit');

  // 主进程推送的状态
  api.on('dsh:status', () => refreshDshStatus());
  api.on('memory:handoff-updated', () => refreshHandoffPreview());
  api.on('plugin:install-progress', (p) => {
    if (!p || !p.stage) return;
    if (p.stage === 'done') toast('插件安装完成 ✅');
    else if (p.stage === 'fail') toast('安装失败，已自动回滚: ' + (p.message || ''), 'err');
    else toast('安装中: ' + (p.message || p.stage));
  });

  await refreshDshStatus();
  await refreshHandoffPreview();
  // 定期刷新（防漏）
  setInterval(async () => {
    await refreshDshStatus();
    await refreshHandoffPreview();
  }, 20000);
}

init();