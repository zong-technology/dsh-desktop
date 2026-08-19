'use strict';
/**
 * qq-bridge.js — QQ 机器人（OneBot 11 协议）↔ DSH 会话双向同步
 *
 * 链路：
 *   QQ 消息 → NapCat(OneBot HTTP) 上报 → 本模块监听 → 转发给 DSH 页面（webview guest preload 操作输入框）
 *   DSH 回复 → preload 读到新消息 → 本模块 → POST /send_private_msg → QQ
 *
 * NapCat 配置要求（见 README）：
 *   - HTTP 服务器开启（默认 http://127.0.0.1:3000）
 *   - HTTP 上报开启，上报地址 = http://127.0.0.1:<listenPort>/onebot
 *   - 事件过滤：仅上报私聊消息（或按需群聊）
 */
const http = require('http');
const { URL } = require('url');

class QQBridge {
  /**
   * @param {object} opts { log, getSettings, onAsk }
   *   getSettings: () => qq 设置 { enabled, apiUrl, listenPort, allowedUsers, prefix }
   *   onAsk: async (text, sender) => 把文本交给 DSH 页面，返回 Promise<string> 回复
   */
  constructor({ log = console, getSettings, onAsk }) {
    this.log = log;
    this.getSettings = getSettings || (() => ({}));
    this.onAsk = onAsk;
    this.server = null;
    this.started = false;
  }

  /** 设置变化时调用：enabled=true 启动监听，false 停止 */
  sync() {
    const s = this.getSettings();
    if (s.enabled && !this.started) {
      this._start(s);
    } else if (!s.enabled && this.started) {
      this._stop();
    } else if (s.enabled && this.started && s.listenPort && this.listenPort !== s.listenPort) {
      this._stop();
      this._start(s);
    }
  }

  _start(s) {
    const listenPort = Number(s.listenPort || 0);
    if (!listenPort) {
      this.log.warn?.('[qq] 未配置监听端口，跳过启动');
      return;
    }
    this.listenPort = listenPort;
    this.server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/onebot') {
        res.writeHead(404).end('not found');
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const ev = JSON.parse(body);
          this._handleEvent(ev);
        } catch (e) {
          this.log.warn?.(`[qq] 事件解析失败: ${e.message}`);
        }
        res.writeHead(204).end();
      });
    });
    this.server.listen(listenPort, '127.0.0.1', () => {
      this.started = true;
      this.log.log?.(`[qq] OneBot 事件监听已启动: http://127.0.0.1:${listenPort}/onebot`);
    });
    this.server.on('error', (e) => this.log.warn?.(`[qq] 监听错误: ${e.message}`));
  }

  _stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.started = false;
    this.listenPort = null;
    this.log.log?.('[qq] OneBot 事件监听已停止');
  }

  _handleEvent(ev) {
    // OneBot 11 私聊消息事件
    if (ev.post_type !== 'message' || ev.message_type !== 'private') return;
    if (ev.message_type === 'private' && ev.sub_type !== 'friend') return;
    const text = this._extractText(ev.raw_message || ev.message || '');
    if (!text) return;
    const s = this.getSettings();
    // 白名单过滤
    if (s.allowedUsers && s.allowedUsers.length) {
      const uid = String(ev.user_id || '');
      if (!s.allowedUsers.some((u) => String(u) === uid)) {
        this.log.log?.(`[qq] 忽略非白名单用户 ${uid}`);
        return;
      }
    }
    // 可选命令前缀（如 !dsh ）
    let prompt = text;
    if (s.prefix) {
      if (!text.startsWith(s.prefix)) return;
      prompt = text.slice(s.prefix.length).trim();
      if (!prompt) return;
    }
    const userId = ev.user_id;
    const groupId = ev.group_id || null;
    this.log.log?.(`[qq] 收到私聊 ${userId}: ${prompt.slice(0, 60)}`);
    // 异步处理：回复通过 onAsk 回调返回
    Promise.resolve()
      .then(() => this.onAsk(prompt, { userId, groupId }))
      .then((reply) => {
        if (reply) {
          this.sendPrivate(userId, reply);
          if (groupId) this.sendGroup(groupId, reply);
        }
      })
      .catch((e) => {
        this.log.warn?.(`[qq] 对话失败: ${e.message}`);
        this.sendPrivate(userId, `⚠️ 处理失败：${e.message}`);
      });
  }

  _extractText(msg) {
    if (typeof msg === 'string') {
      // 去掉 CQ 码（图片/at 等），保留文本
      return msg.replace(/\[CQ:[^\]]+\]/g, '').trim();
    }
    if (Array.isArray(msg)) {
      return msg
        .filter((seg) => seg.type === 'text')
        .map((seg) => seg.data?.text || '')
        .join('')
        .trim();
    }
    return '';
  }

  /** 发送私聊消息 */
  async sendPrivate(userId, message) {
    return this._api('send_private_msg', { user_id: Number(userId), message });
  }

  /** 发送群消息 */
  async sendGroup(groupId, message) {
    return this._api('send_group_msg', { group_id: Number(groupId), message });
  }

  async _api(action, params) {
    const s = this.getSettings();
    const base = (s.apiUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    try {
      const res = await fetch(`${base}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json().catch(() => ({}));
      if (data && data.status === 'ok') return true;
      this.log.warn?.(`[qq] ${action} 返回: ${JSON.stringify(data).slice(0, 120)}`);
      return false;
    } catch (e) {
      this.log.warn?.(`[qq] ${action} 失败: ${e.message}`);
      return false;
    }
  }

  /** 测试连接：ping NapCat */
  async test() {
    const s = this.getSettings();
    const base = (s.apiUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    try {
      const res = await fetch(`${base}/get_login_info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      if (data && data.status === 'ok' && data.data) {
        return { ok: true, nick: data.data.nickname, userId: data.data.user_id };
      }
      return { ok: false, error: `返回异常: ${JSON.stringify(data).slice(0, 120)}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

module.exports = QQBridge;
