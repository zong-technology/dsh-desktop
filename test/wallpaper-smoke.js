'use strict';
/**
 * wallpaper-smoke.js — 动态壁纸引擎冒烟测试（Electron 环境）
 * 运行：npm run test:wallpaper
 * 验证：WorkerW 桌面层定位 → 窗口创建 → 挂载 → 停止。退出码 0 = 通过。
 */
const { app } = require('electron');
const path = require('path');
const WallpaperEngine = require('../src/wallpaper');
const { findWorkerW } = require('../src/win32-probe');

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

app.whenReady().then(async () => {
  const uiDir = path.join(__dirname, '..', 'ui');
  const engine = new WallpaperEngine({ uiDir, log: console });
  const failed = [];
  try {
    const r = findWorkerW();
    if (!r.ok) {
      console.log(`[smoke] WorkerW 定位: FAIL (${r.error})`);
      failed.push('workerW');
    } else {
      console.log(`[smoke] WorkerW 定位: OK (0x${r.workerW.toString(16)})`);
    }

    const page = 'file:///' + path.join(uiDir, 'wallpaper.html').replace(/\\/g, '/');
    await engine.startVideo('C:/__dsh_smoke_nonexistent__.mp4');
    await new Promise((res) => setTimeout(res, 1500));

    if (engine.isActive()) {
      console.log('[smoke] 壁纸窗口: ACTIVE');
    } else {
      console.log('[smoke] 壁纸窗口: INACTIVE');
      failed.push('window');
    }
    if (engine._attachError) {
      console.log(`[smoke] 桌面挂载: FAIL (${engine._attachError})`);
      failed.push('attach');
    } else {
      console.log('[smoke] 桌面挂载: OK');
    }

    await engine.stop();
    console.log('[smoke] 停止: OK');
    if (engine.isActive()) failed.push('stop');
  } catch (e) {
    console.log(`[smoke] 异常: FAIL (${e.message})`);
    failed.push('exception');
  }
  console.log(failed.length ? `[smoke] 结果: FAIL (${failed.join(',')})` : '[smoke] 结果: PASS');
  app.exit(failed.length ? 1 : 0);
});