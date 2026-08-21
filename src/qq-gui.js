'use strict';
/**
 * qq-gui.js — QQ 直连 DSH web (3080) GUI 会话桥接
 * 让 QQ 消息直接进入 GUI 的同一个会话（跟电脑端对话一样）：
 *  - session.prompt (mode: queue) 发消息（排队不打断当前任务）
 *  - 轮询 session.history 捕获新 turn 的 assistant 文本回复
 * 使用 sessionId 关联 GUI 当前会话（cwd 匹配工作目录，最新者优先）。
 */
const http = require('http');

const API_HOST = process.env.DSH_API_HOST || '127.0.0.1';
const API_PORT = Number(process.env.DSH_API_PORT || 3080);
const POLL_INTERVAL_MS = 2000;
const PROMPT_TIMEOUT_MS = 600000; // 10 分钟上限（任务可能较长）

function rpc(method, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: 'qq-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      method,
      payload: payload || {},
    });
    const req = http.request(
      {
        host: API_HOST,
        port: API_PORT,
        path: '/api/' + method,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Host: `${API_HOST}:${API_PORT}`,
          Origin: `http://${API_HOST}:${API_PORT}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(d);
            if (json && json.result && json.result.ok) resolve(json.result.value);
            else reject(new Error((json?.result?.error?.message) || `RPC ${method} 失败`));
          } catch (e) {
            reject(new Error(`RPC ${method} 响应解析失败: ${String(e)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`RPC ${method} 超时`));
    });
    req.write(body);
    req.end();
  });
}

/** 找到 GUI 当前会话（cwd 匹配优先；其次最新） */
async function findGuiSession(cwdHints) {
  const value = await rpc('session.list', {});
  const items = value?.items || [];
  if (!items.length) return null;
  const hints = (cwdHints || []).map((h) => h.replace(/\\/g, '/').toLowerCase());
  const scored = items
    .map((it) => {
      const cwd = (it.cwd || '').replace(/\\/g, '/').toLowerCase();
      let score = 0;
      if (hints.length && hints.includes(cwd)) score += 100;
      if (it.running) score += 10;
      if (it.projections?.sessionStats?.turns) score += Math.min(it.projections.sessionStats.turns, 1000) / 100;
      return { ...it, _score: score };
    })
    .sort((a, b) => b._score - a._score || (b.updatedAt || 0) - (a.updatedAt || 0));
  return scored[0] || items[0];
}

/** 从 history 事件里提取某 turn 的 assistant 文本 */
function extractAssistantText(events, turn) {
  let text = '';
  for (const e of events) {
    const ev = e.event || {};
    if (ev.type === 'assistant/message' && (turn === undefined || ev.data?.turn === turn)) {
      const parts = ev.data?.message?.content || [];
      for (const p of parts) {
        if (p.type === 'text') text += p.text;
      }
    }
  }
  return text.trim();
}

function contentHasText(events, needle) {
  for (const e of events) {
    const ev = e.event || {};
    if (ev.type === 'agent/inbox/spliced') {
      const json = JSON.stringify(ev.data);
      if (json.includes(needle)) return true;
    }
  }
  return false;
}

/**
 * 发送消息到 GUI 会话并等待回复。
 * @param {string} text - 用户消息
 * @param {object} opts - { cwdHints, baseSessionId, onStatus, onProgress, onChunk }
 *   onChunk(chunk, isFinal) - 流式推送：AI 新产出的文本增量（按语义块），isFinal=true 表示最后一段
 * @returns {Promise<{ ok, text, sessionId, error }>}
 */
async function sendToGuiSession(text, opts = {}) {
  const log = opts.log || console;
  try {
    let sessionId = opts.baseSessionId;
    if (!sessionId) {
      const found = await findGuiSession(opts.cwdHints);
      if (!found) return { ok: false, error: 'GUI 会话不存在（DSH web 未运行？）' };
      sessionId = found.sessionId;
      log.log?.(`[qq-gui] 找到 GUI 会话 ${sessionId}`);
    }
    // 记录发送前的最后 seq（用于判断新回复）
    let beforeSeq = 0;
    try {
      const hist = await rpc('session.history', { sessionId, limit: 50, beforeSeq: 999999999 });
      const evs = hist?.events || [];
      beforeSeq = evs.length ? evs[evs.length - 1].event?.seq || 0 : 0;
    } catch (e) {
      log.warn?.(`[qq-gui] 读取历史失败: ${e.message}`);
    }

    // 发送消息（queue 排队不打断当前任务）
    await rpc('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: 'Asia/Shanghai',
    });
    log.log?.(`[qq-gui] 已发送到 GUI 会话 (queue)`);

    // ===== 流式推送：维护已推送游标（按字符数，防重复）=====
    let pushedLen = 0; // 已推送的 watcherTurn 文本长度
    let pendingChunk = ''; // 待推送的积累文本
    const CHUNK_MAX = 60; // 单块最大字符（超过即强制分块）
    const SEMI_BOUNDARY = /[。！？!?；;\n]/; // 语义边界（句号/感叹/问号/分号/换行）
    // 尝试推送当前积累块（满足边界或长度或 final）
    const flushChunk = (fullText, isFinal) => {
      if (!opts.onChunk || !pendingChunk) return;
      const chunk = pendingChunk.trim();
      pendingChunk = '';
      if (chunk) {
        log.log?.(`[qq-gui] 流式推送${isFinal ? '(尾)' : ''}: ${chunk.slice(0, 40)}…`);
        try { opts.onChunk(chunk, isFinal); } catch {}
      }
    };
    const considerChunk = (fullText, isFinal) => {
      if (!opts.onChunk || !fullText) return;
      const newPart = fullText.slice(pushedLen);
      if (!newPart) return;
      pendingChunk += newPart;
      pushedLen = fullText.length;
      // 语义边界分块：在边界后截断推送
      let cut = -1;
      for (let i = 0; i < pendingChunk.length; i++) {
        if (SEMI_BOUNDARY.test(pendingChunk[i])) cut = i + 1;
      }
      if (cut > 0 || pendingChunk.length >= CHUNK_MAX || isFinal) {
        // 若有边界 → 推送到最后边界；无边界但超长 → 整块推；final → 全推
        if (cut > 0) {
          const head = pendingChunk.slice(0, cut);
          pendingChunk = pendingChunk.slice(cut);
          const chunk = head.trim();
          if (chunk) {
            log.log?.(`[qq-gui] 流式推送: ${chunk.slice(0, 40)}…`);
            try { opts.onChunk(chunk, false); } catch {}
          }
        } else {
          flushChunk(fullText, isFinal);
        }
      }
    };

    // 等待：新 turn 完成 且 回复文本非空
    const deadline = Date.now() + PROMPT_TIMEOUT_MS;
    // 只关注信号之后才开始的 turn（忽略旧 turn 继续产生的事件）
    let watcherTurn = null; // 新 turn 的编号
    let sawNewTurn = false;
    let lastProgressAt = 0; // 上次进度报告时间
    let lastSeenSeq = beforeSeq; // 上次看到的最后 seq（判断是否还在推进）
    let lastToolName = ''; // 最近调用的工具（用于进度报告）
    let lastToolAt = 0; // 最近工具调用时间
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      let hist;
      try {
        hist = await rpc('session.history', { sessionId, limit: 300, beforeSeq: 999999999 });
      } catch {
        continue;
      }
      const evs = hist?.events || [];
      if (!evs.length) continue;
      const lastEv = evs[evs.length - 1]?.event || {};
      const lastSeq = lastEv.seq || 0;
      // 提取最近的工具调用（tool/call 事件），用于进度报告
      for (const e of evs) {
        const ev = e.event || {};
        if (ev.type === 'tool/call' && (ev.seq || 0) > beforeSeq) {
          const tname = ev.data?.tool || ev.data?.name || ev.data?.toolName || '';
          if (tname) { lastToolName = tname; lastToolAt = Date.now(); }
        }
      }
      // —— 进度报告：每 5 分钟一次；若刚有新工具调用也顺带报告（不超过每 30 秒一次）——
      const now = Date.now();
      const toolJustChanged = lastToolName && (now - lastToolAt < 10000) && (now - lastProgressAt >= 30000);
      if (opts.onProgress && (now - lastProgressAt >= 300000 || toolJustChanged)) {
        lastProgressAt = now;
        const advancing = lastSeq > lastSeenSeq; // 有新事件 = 仍在推进
        const toolPart = lastToolName ? `，正在调用工具 ${lastToolName}` : '';
        // 提取该 turn 已产生的回复片段（让用户"实时看到对话"）
        let partial = '';
        if (sawNewTurn) {
          const texts = [];
          for (const e of evs) {
            const ev = e.event || {};
            if ((ev.seq || 0) <= beforeSeq) continue;
            if (ev.type === 'assistant/message' && ev.data?.turn === watcherTurn) {
              const parts = ev.data?.message?.content || [];
              for (const p of parts) if (p.type === 'text') texts.push(p.text);
            }
          }
          partial = texts.join('').trim();
        }
        const partialPart = partial ? `。已输出：${partial.slice(-120)}` : '';
        const phase = sawNewTurn
          ? `正在处理中${toolPart}${partialPart}（turn ${watcherTurn}` + (advancing ? '，持续运行中）' : '，当前卡顿/等待中）')
          : advancing
            ? '消息已进入队列，AI 正在处理之前的任务…'
            : '消息已排队，AI 可能较忙，仍在等待…';
        opts.onProgress(phase, { advancing, lastSeq, toolName: lastToolName });
      }
      lastSeenSeq = Math.max(lastSeenSeq, lastSeq);
      // 判断：信号之后是否开始了新 turn
      if (!sawNewTurn) {
        const starts = evs.filter((e) => (e.event?.type === 'turn/start') && (e.event?.seq || 0) > beforeSeq);
        if (starts.length) {
          sawNewTurn = true;
          watcherTurn = starts[starts.length - 1].event?.data?.turn;
          log.log?.(`[qq-gui] 新 turn ${watcherTurn} 已开始`);
        }
      }
      // 若已看到新 turn：等它 turn/end + 提取该 turn 文本（流式推送增量）
      if (sawNewTurn) {
        let done = false;
        const texts = [];
        for (const e of evs) {
          const ev = e.event || {};
          const seq = ev.seq || 0;
          if (seq <= beforeSeq) continue;
          if (ev.type === 'turn/end' && ev.data?.turn === watcherTurn) done = true;
          if (ev.type === 'assistant/message' && ev.data?.turn === watcherTurn) {
            const parts = ev.data?.message?.content || [];
            for (const p of parts) if (p.type === 'text') texts.push(p.text);
          }
        }
        const full = texts.join('');
        // ★ 流式：把新出现的文本增量按语义块推送
        considerChunk(full, false);
        // 每轮 poll 后若积累超时也推一把（防止长时间无边界）
        if (pendingChunk && pendingChunk.length >= 10) flushChunk(full, false);
        const reply = full.trim();
        if (done) {
          // turn 结束：推送剩余尾巴（final）
          considerChunk(full, true);
          flushChunk(full, true);
          if (reply) return { ok: true, text: reply, sessionId };
          // turn 结束但无文本（可能被取消/空回复）——继续等下一个新 turn
          sawNewTurn = false;
          watcherTurn = null;
          pushedLen = 0;
          pendingChunk = '';
        }
      } else if (Date.now() > deadline - 30000) {
        // 接近超时且从未开始新 turn：报告等待状态
        return { ok: false, error: 'GUI 会话当前正忙（消息已排队，等待轮到你）' };
      }
    }
    // 最终超时：若还有未推完的文本，推送尾巴标记为 final
    if (opts.onChunk && pendingChunk) flushChunk(pendingChunk, true);
    return { ok: false, error: '等待 GUI 回复超时' };
  } catch (e) {
    log.warn?.(`[qq-gui] 调用失败: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = { sendToGuiSession, findGuiSession, rpc };