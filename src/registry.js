'use strict';
/**
 * registry.js — 推荐插件 / Skill 注册表
 *
 * 优先从 GitHub raw 拉取（发布后可云端更新），失败自动回退本地 registry/plugins.json。
 */
const fs = require('fs');

class Registry {
  /**
   * @param {object} opts { localPath, remoteUrl, log }
   */
  constructor({ localPath, remoteUrl, log = console }) {
    this.localPath = localPath;
    this.remoteUrl = remoteUrl;
    this.log = log;
  }

  async getRecommended() {
    if (this.remoteUrl) {
      try {
        const res = await fetch(this.remoteUrl, {
          headers: { 'User-Agent': 'dsh-desktop' },
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data.items)) {
            return { source: 'remote', items: data.items };
          }
        }
      } catch (e) {
        this.log.warn?.(`推荐列表远程获取失败，回退本地: ${e.message}`);
      }
    }
    try {
      const data = JSON.parse(fs.readFileSync(this.localPath, 'utf8'));
      return { source: 'local', items: Array.isArray(data.items) ? data.items : [] };
    } catch (e) {
      return { source: 'local', items: [], error: e.message };
    }
  }
}

module.exports = Registry;