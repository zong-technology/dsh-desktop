'use strict';
/**
 * registry.js — 推荐插件 / Skill 注册表
 *
 * 优先从 GitHub raw 拉取（发布后可云端更新），失败自动回退本地 registry/plugins.json。
 * 另外提供 GitHub 仓库市场（dsh-web-ui 官方生态插件集合）的包列表，供插件市场页展示。
 */
const fs = require('fs');

/** dsh-web-ui 官方生态仓库（社区插件市场） */
const GITHUB_MARKET_REPO = 'zhu1090093659/dsh-web-ui';
const MARKET_CACHE_TTL = 60 * 60 * 1000; // 1 小时缓存

class Registry {
  /**
   * @param {object} opts { localPath, remoteUrl, log }
   */
  constructor({ localPath, remoteUrl, log = console }) {
    this.localPath = localPath;
    this.remoteUrl = remoteUrl;
    this.log = log;
    this.marketCache = null;
    this.marketCacheAt = 0;
    this.searchCache = null;
    this.searchCacheAt = 0;
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

  /**
   * 拉取 GitHub 仓库市场（dsh-web-ui）的插件包列表，生成市场条目。
   * 带 1 小时缓存；任何失败静默返回 []（不阻塞本地市场）。
   * 条目字段：{ id, name, kind:'dsh-plugin', description, author, tags, github, installCmd, marketSource:'github-market' }
   */
  async fetchGithubMarket() {
    if (this.marketCache && Date.now() - this.marketCacheAt < MARKET_CACHE_TTL) {
      return this.marketCache;
    }
    const gh = (url, token) =>
      fetch(url, {
        headers: { 'User-Agent': 'dsh-desktop', Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(15000),
      });
    try {
      // 1) 拿仓库默认分支 + 包目录树（一次性列出所有 package.json 路径）
      const meta = await (await gh(`https://api.github.com/repos/${GITHUB_MARKET_REPO}`)).json();
      const branch = meta.default_branch || 'main';
      const tree = await (await gh(`https://api.github.com/repos/${GITHUB_MARKET_REPO}/git/trees/${branch}?recursive=1`)).json();
      const pkgPaths = (tree.tree || [])
        .filter((t) => t.type === 'blob' && /^packages\/[^/]+\/package\.json$/.test(t.path))
        .map((t) => t.path);
      if (!pkgPaths.length) return [];

      // 2) 并行读每个包的 package.json（限制并发，避免触发限流）
      const items = [];
      const CHUNK = 5;
      for (let i = 0; i < pkgPaths.length; i += CHUNK) {
        const slice = pkgPaths.slice(i, i + CHUNK);
        const results = await Promise.all(
          slice.map(async (p) => {
            try {
              const c = await (await gh(`https://api.github.com/repos/${GITHUB_MARKET_REPO}/contents/${p}?ref=${branch}`)).json();
              if (!c || !c.content) return null;
              const pj = JSON.parse(Buffer.from(c.content, 'base64').toString('utf8'));
              const dirName = p.split('/')[1];
              return {
                id: 'ghm-' + dirName,
                name: pj.name || dirName,
                kind: 'dsh-plugin',
                marketSource: 'github-market',
                version: pj.version || 'latest',
                description: (pj.description || `${dirName} — dsh-web-ui 官方生态插件`).slice(0, 200),
                author: 'dsh-web-ui 社区',
                tags: ['DSH插件', '社区', 'dsh-web-ui'],
                github: `https://github.com/${GITHUB_MARKET_REPO}/tree/main/packages/${dirName}`,
                installCmd: `npx @deepseek-ai/dsh plugin --profile web add ${pj.name}`,
              };
            } catch (e) {
              return null;
            }
          })
        );
        items.push(...results.filter(Boolean));
      }
      this.marketCache = items;
      this.marketCacheAt = Date.now();
      this.log.log?.(`GitHub 仓库市场: 拉取到 ${items.length} 个插件`);
      return items;
    } catch (e) {
      this.log.warn?.(`GitHub 仓库市场拉取失败: ${e.message}`);
      return [];
    }
  }

  /**
   * 搜索 GitHub 上全部适配 DSH 的插件仓库（热门优先）。
   * 用 GitHub search API 按多个关键词查询，按 stars 降序；带 1 小时缓存。
   * 条目字段：{ id, name, kind:'dsh-plugin', description, author, stars, tags, github, installCmd, marketSource:'github-search' }
   */
  async searchGithubPlugins() {
    if (this.searchCache && Date.now() - this.searchCacheAt < MARKET_CACHE_TTL) {
      return this.searchCache;
    }
    const token = process.env.DSH_GITHUB_TOKEN || '';
    const gh = (url) =>
      fetch(url, {
        headers: {
          'User-Agent': 'dsh-desktop',
          Accept: 'application/vnd.github+json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(15000),
      });
    const QUERIES = [
      'dsh- in:name sort:stars',
      'dsh plugin in:name sort:stars',
      'dsh-vision in:name,description sort:stars',
      'dsh-image in:name,description sort:stars',
      'dsh-plugin topic:dsh-plugin',
    ];
    // 排除 DSH 本体/知名无关大仓库
    const EXCLUDE = /zong-technology\/dsh-desktop|deepseek-harness|^ollama\/|deer-flow|open-design|learn-claude|OmniRoute|CodeWhale/i;
    try {
      const seen = new Set();
      const items = [];
      for (const q of QUERIES) {
        try {
          // per_page 缩小 + 只取前面，减少限流
          const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=12`;
          const res = await gh(url);
          if (!res.ok) {
            this.log.warn?.(`GitHub 搜索失败(${res.status}) ${q}`);
            continue;
          }
          const data = await res.json();
          for (const repo of data.items || []) {
            const full = repo.full_name;
            if (seen.has(full) || EXCLUDE.test(full)) continue;
            // 只保留 DSH 插件特征：仓库名含 dsh（且非 DSH 本体），或描述含 dsh plugin/插件
            const desc = (repo.description || '').slice(0, 200);
            const name = repo.name || '';
            const isPlugin = /^dsh-|dsh[-_ ]/i.test(name) && !/harness$|deepseek-harness/i.test(full);
            const descHint = /dsh.{0,12}(plugin|插件|vision|image|skill|tool|panel|board|graph)/i.test(`${name} ${desc}`) && !/deepseek-harness/i.test(full);
            if (!isPlugin && !descHint) continue;
            if (/harness|harness-ui|harness-core/i.test(name) && repo.stargazers_count > 20000) continue;
            seen.add(full);
            items.push({
              id: 'ghs-' + full.replace(/[^a-z0-9-]/gi, '-').toLowerCase(),
              name: full,
              kind: 'dsh-plugin',
              marketSource: 'github-search',
              version: `⭐ ${repo.stargazers_count}`,
              description: desc,
              author: repo.owner?.login || 'GitHub',
              stars: repo.stargazers_count || 0,
              tags: ['DSH插件', 'GitHub', '热门'],
              github: repo.html_url,
              installCmd: `npx @deepseek-ai/dsh plugin --profile web add github:${full}`,
            });
          }
        } catch (e) {
          this.log.warn?.(`GitHub 搜索异常: ${e.message}`);
        }
      }
      // 按 star 排序
      items.sort((a, b) => (b.stars || 0) - (a.stars || 0));
      this.searchCache = items;
      this.searchCacheAt = Date.now();
      this.log.log?.(`GitHub 热门插件搜索: 找到 ${items.length} 个仓库`);
      return items;
    } catch (e) {
      this.log.warn?.(`GitHub 插件搜索失败: ${e.message}`);
      return [];
    }
  }
}

module.exports = Registry;