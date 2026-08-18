'use strict';
/**
 * memory.js — 上下文记忆服务
 *
 * 职责：
 *   1. 接收 DSH 页面上注入脚本上报的对话快照（文本/标题/URL）
 *   2. 估算 token 用量，接近上下文上限（默认 70%）时自动生成简洁交接摘要
 *   3. 摘要持久化到 memory/handoffs/ 并镜像一份 memory/HANDOFF.md 留给下一个会话
 *   4. 可选：配置 DeepSeek API Key 后用 LLM 生成更高质量的总结（默认关闭）
 *
 * 纯 Node 实现，无外部依赖。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const DEFAULT_SETTINGS = {
  enabled: true,
  contextLimit: 128000,      // 上下文窗口估算上限（token）
  summarizeAt: 0.7,          // 达到该比例时触发总结
  deepseekApiKey: '',        // 可选：LLM 总结
  autoInjectHandoff: true,   // 下次启动自动注入交接摘要到对话框
};

class MemoryService {
  /**
   * @param {object} opts { memoryDir, settingsFile, log }
   */
  constructor({ memoryDir, settingsFile, log = console }) {
    this.memoryDir = memoryDir;
    this.settingsFile = settingsFile;
    this.log = log;
    this._settings = null;
    this._latest = null; // 当前会话最新快照 { text, title, url, ts, tokens, pct }
    this._lastSummaryAt = 0;
  }

  loadSettings() {
    if (this._settings) return this._settings;
    try {
      this._settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')) };
    } catch {
      this._settings = { ...DEFAULT_SETTINGS };
    }
    return this._settings;
  }

  async saveSettings(patch = {}) {
    const s = this.loadSettings();
    Object.assign(s, patch);
    await fsp.mkdir(path.dirname(this.settingsFile), { recursive: true });
    await fsp.writeFile(this.settingsFile, JSON.stringify(s, null, 2), 'utf8');
    return s;
  }

  /** 估算 token 数：中文约 0.6 token/字，其他约 0.25 token/字符 */
  estimateTokens(text) {
    if (!text) return 0;
    const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    const other = text.length - cjk;
    return Math.ceil(cjk * 0.6 + other * 0.25);
  }

  /**
   * 接收页面快照上报。达到阈值时自动总结。
   * @returns {Promise<{summarized: boolean, tokens: number, pct: number}>}
   */
  async report({ text, title, url, ts }) {
    const s = this.loadSettings();
    if (!s.enabled) return { summarized: false, tokens: 0, pct: 0 };
    const tokens = this.estimateTokens(text);
    const pct = tokens / s.contextLimit;
    this._latest = { text: String(text || '').slice(-300000), title, url, ts: ts || Date.now(), tokens, pct };

    const shouldSummarize =
      pct >= s.summarizeAt &&
      Date.now() - this._lastSummaryAt > 60000 && // 防抖：1 分钟内不重复总结
      tokens > 2000;

    if (shouldSummarize) {
      await this.summarizeNow('auto');
    }
    return { summarized: shouldSummarize, tokens, pct };
  }

  /**
   * 立即总结（auto=阈值触发 / manual=用户手动 / llm=用 LLM）。
   * 生成交接摘要并写入 handoffs/ 与 HANDOFF.md。
   */
  async summarizeNow(mode = 'manual') {
    const s = this.loadSettings();
    const snap = this._latest;
    if (!snap || !snap.text) return { ok: false, error: '暂无对话快照可总结' };

    let summary;
    if (mode === 'llm' && s.deepseekApiKey) {
      summary = await this._summarizeWithLLM(snap.text.slice(-60000), s.deepseekApiKey);
      if (!summary) {
        this.log.warn?.('LLM 总结失败，回退到规则总结');
        summary = this._summarizeRules(snap.text);
      }
    } else {
      summary = this._summarizeRules(snap.text);
    }

    const handoff = {
      summary,
      mode,
      at: new Date().toISOString(),
      title: snap.title || 'DSH 会话',
      url: snap.url || '',
      tokens: snap.tokens,
      pct: snap.pct,
      estimateTokens: this.estimateTokens(summary),
    };

    await fsp.mkdir(path.join(this.memoryDir, 'handoffs'), { recursive: true });
    const convId = this._convId(snap.url, snap.title);
    await fsp.writeFile(
      path.join(this.memoryDir, 'handoffs', `${convId}.json`),
      JSON.stringify(handoff, null, 2),
      'utf8'
    );
    // 镜像一份易读的交接文件
    await fsp.writeFile(
      path.join(this.memoryDir, 'HANDOFF.md'),
      `# 📋 会话交接摘要\n\n> 生成时间：${handoff.at}\n> 来源会话：${handoff.title}\n> 模式：${mode}\n\n${summary}\n\n---\n*由 DSH Desktop 上下文记忆自动生成*\n`,
      'utf8'
    );
    this._lastSummaryAt = Date.now();
    this.log.log?.(`已生成交接摘要 (${mode})，共 ${handoff.estimateTokens} tokens`);
    return { ok: true, handoff };
  }

  /** 取最近一次交接摘要 */
  async getHandoff() {
    const dir = path.join(this.memoryDir, 'handoffs');
    try {
      const files = await fsp.readdir(dir);
      if (!files.length) return null;
      files.sort();
      const last = files[files.length - 1];
      return JSON.parse(await fsp.readFile(path.join(dir, last), 'utf8'));
    } catch {
      return null;
    }
  }

  async listConversations() {
    const dir = path.join(this.memoryDir, 'handoffs');
    try {
      const files = await fsp.readdir(dir);
      const out = [];
      for (const f of files.filter((x) => x.endsWith('.json'))) {
        try {
          out.push(JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8')));
        } catch { /* ignore */ }
      }
      out.sort((a, b) => (a.at < b.at ? 1 : -1));
      return out;
    } catch {
      return [];
    }
  }

  /** 规则总结：结构化完整摘要（目标/待办/结论/最近内容/关键词） */
  _summarizeRules(text) {
    const raw = String(text || '');
    const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    if (!lines.length) return '（对话内容为空）';

    const isHeading = (l) => /^(#{1,6}\s|【[^】]+】)/.test(l) || (/^[-*•]\s/.test(l) && l.length <= 120);
    const isCode = (l) => /^[`~]{3}/.test(l) || /^\s{2,}/.test(l);
    const isQuestion = (l) => /[?？]$/.test(l);

    // —— 目标 / 开头要点 ——
    const head = [];
    for (const l of lines.slice(0, 30)) {
      if (isCode(l)) continue;
      if (isHeading(l) || isQuestion(l) || head.length < 4) {
        if (head.length >= 8) break;
        head.push(l.length > 140 ? l.slice(0, 140) + '…' : l);
      }
    }

    // —— 待办 / 未完成 ——
    const todo = [];
    const todoRx = /(待办|TODO|未完成|还没|下一步|接下来|需要(做|完成|处理)|别忘了|记得|之后要|计划|待处理)/i;
    for (const l of lines) {
      if (isCode(l)) continue;
      if (todoRx.test(l) && l.length <= 200) {
        todo.push(l);
        if (todo.length >= 10) break;
      }
    }

    // —— 结论 / 关键决策 ——
    const done = [];
    const doneRx = /(结论|决定|确定|完成|已解决|搞定|同意|最终|方案|选择|结果是|已生成|已写入)/i;
    for (const l of lines.slice(-Math.min(lines.length, 800))) {
      if (isCode(l)) continue;
      if (doneRx.test(l) && l.length <= 200) {
        done.push(l);
        if (done.length >= 10) break;
      }
    }

    // —— 最近内容（结尾，尽量完整） ——
    const tail = lines.slice(-100).filter((l) => !isCode(l)).slice(-30);

    // —— 关键词 ——
    const stop = new Set([
      '的', '了', '是', '我', '你', '他', '她', '它', '们', '这', '那', '在', '和', '与', '就', '都', '而', '及', '着',
      '或', '一个', '我们', '你们', '可以', '什么', '怎么', '为什么', '因为', '所以', '但是', '如果', '没有', '这个', '那个',
      'the', 'a', 'an', 'is', 'are', 'was', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'with', 'that', 'this', 'it',
    ]);
    const freq = new Map();
    const words = (raw.match(/[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,6}/g) || []).slice(-3000);
    for (const w of words) {
      const k = w.toLowerCase();
      if (stop.has(k)) continue;
      freq.set(k, (freq.get(k) || 0) + 1);
    }
    const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([w]) => w);

    const parts = [];
    parts.push('# 📋 会话交接摘要（自动生成）');
    parts.push('');
    parts.push('**会话主题/目标**');
    if (head.length) for (const p of head) parts.push(`- ${p}`);
    else parts.push('- （未能提取，请在下方最近内容中查看）');
    parts.push('');
    if (todo.length) {
      parts.push('**未完成 / 待办**');
      for (const p of todo) parts.push(`- ${p}`);
      parts.push('');
    }
    if (done.length) {
      parts.push('**结论 / 已完成**');
      for (const p of done) parts.push(`- ${p}`);
      parts.push('');
    }
    parts.push(`**最近讨论（结尾 ${tail.length} 条）**`);
    for (const l of tail) parts.push(`- ${l.length > 160 ? l.slice(0, 160) + '…' : l}`);
    parts.push('');
    if (top.length) parts.push(`**关键词**：${top.join('、')}`);
    parts.push('');
    parts.push('> 💡 使用方式：摘要已自动注入新会话输入框（或复制上方内容），发送给模型即可无缝衔接上下文。');
    return parts.join('\n');
  }

  async _summarizeWithLLM(tail, apiKey) {
    try {
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'deepseek-chat',
          temperature: 0.3,
          max_tokens: 600,
          messages: [
            {
              role: 'system',
              content:
                '你是会话压缩助手。把用户提供的对话压缩成一份简洁的“交接摘要”，供下一个会话继续使用。要求：保留目标、已完成的结论、未完成事项、关键约定/路径/命令；使用要点列表；总长度不超过 400 字。',
            },
            { role: 'user', content: tail },
          ],
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) {
        this.log.warn?.(`LLM 总结 HTTP ${res.status}`);
        return null;
      }
      const data = await res.json();
      return data?.choices?.[0]?.message?.content?.trim() || null;
    } catch (e) {
      this.log.warn?.(`LLM 总结异常: ${e.message}`);
      return null;
    }
  }

  _convId(url, title) {
    try {
      if (url) return new URL(url).pathname.replace(/[^a-z0-9_-]/gi, '_').slice(-40) || 'default';
    } catch { /* ignore */ }
    return String(title || 'default').replace(/[^a-z0-9_-]/gi, '_').slice(-40) || 'default';
  }
}

module.exports = MemoryService;