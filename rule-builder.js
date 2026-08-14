// rule-builder.js —— 纯函数模块（不依赖任何 chrome API）
// 黑白名单条目 → declarativeNetRequest 动态规则；同时提供匹配判定供弹窗/测试使用。
//
// 匹配语义（与 DNR urlFilter 保持一致）：
//   - 黑名单条目 D    → urlFilter "||D^"    「||」域名锚点：匹配 D 及任意子域名；「^」边界
//   - 白名单条目 U    → urlFilter "*U^"    严格·路径边界：URL 包含 U 且其后是分隔符或结尾
//   - 白名单优先级(2) > 黑名单优先级(1)，命中白名单即放行
//
//  例：黑名单 "youtube.com" + 白名单 "youtube.com/watch=1234"
//      → 放行 youtube.com/watch=1234 及 watch=1234&t=60
//      → 拦截 youtube.com/watch=12345、youtube.com 任意其他页面

'use strict';

(function (global) {
  // DNR 动态规则上限为 5000（unsafe），留出余量
  const MAX_RULES = 4900;

  const ALL_RESOURCE_TYPES = [
    'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
    'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket',
    'webtransport', 'webbundle', 'other',
  ];

  // urlFilter 中的特殊字符，用户条目中不允许出现
  const FORBIDDEN = /[*|^]/;

  // 规范化用户输入：小写、去协议头、去 www.、去 fragment、去首尾空白与结尾斜杠
  function normalizeEntry(raw) {
    if (typeof raw !== 'string') return '';
    let s = raw.trim().toLowerCase();
    s = s.replace(/^https?:\/\//, '');
    s = s.replace(/^www\./, '');
    s = s.replace(/#.*$/, '');
    s = s.replace(/\/+$/, '');
    s = s.replace(/\s+/g, '');
    return s;
  }

  function isValidEntry(entry) {
    return entry.length > 0 && !FORBIDDEN.test(entry);
  }

  function unique(list) {
    return [...new Set(list)];
  }

  function makeRule(id, priority, type, urlFilter) {
    return {
      id,
      priority,
      action: { type },
      condition: { urlFilter, resourceTypes: ALL_RESOURCE_TYPES },
    };
  }

  // 构建动态规则列表：黑名单规则 id 1..N（优先级 1），白名单规则 id 1001..（优先级 2）
  function buildRules(blacklist, whitelist) {
    const bl = unique((blacklist || []).map(normalizeEntry).filter(isValidEntry));
    const wl = unique((whitelist || []).map(normalizeEntry).filter(isValidEntry));
    const totalEntries = bl.length + wl.length;
    const rules = [];
    for (const d of bl) {
      if (rules.length >= MAX_RULES) break;
      rules.push(makeRule(rules.length + 1, 1, 'block', '||' + d + '^'));
    }
    for (const u of wl) {
      if (rules.length >= MAX_RULES) break;
      rules.push(makeRule(1000 + rules.length + 1, 2, 'allow', '*' + u + '^'));
    }
    return { rules, truncated: rules.length < totalEntries, totalEntries };
  }

  // ---- 迷你 urlFilter 匹配器（仅支持本扩展生成的模式：可选 || / 前置 * / 尾随 ^）----

  function isHostStart(url, i) {
    if (i === 0) return true;
    const schemeEnd = url.indexOf('://');
    if (schemeEnd !== -1 && i === schemeEnd + 3) return true;
    return url[i - 1] === '.';
  }

  // ^ 分隔符：匹配结尾，或任何非 字母/数字/_ - . % 的字符
  function isSeparatorOrEnd(url, i) {
    if (i >= url.length) return true;
    return !/[a-zA-Z0-9_.%\-]/.test(url[i]);
  }

  function matchUrlFilter(url, filter) {
    let body = filter;
    let domainAnchor = false;
    let endBoundary = false;
    if (body.startsWith('||')) { domainAnchor = true; body = body.slice(2); }
    if (body.startsWith('*')) { body = body.slice(1); }
    if (body.endsWith('^')) { endBoundary = true; body = body.slice(0, -1); }
    if (!body) return false;
    let i = url.indexOf(body);
    while (i !== -1) {
      if ((!domainAnchor || isHostStart(url, i)) && (!endBoundary || isSeparatorOrEnd(url, i + body.length))) {
        return true;
      }
      i = url.indexOf(body, i + 1);
    }
    return false;
  }

  // 判定完整 URL 在黑白名单下的结果：'whitelisted' | 'blocked' | 'not-blocked'
  function evaluate(url, blacklist, whitelist, enabled) {
    if (enabled === false) return 'not-blocked';
    const u = typeof url === 'string' ? url.toLowerCase() : '';
    const wl = unique((whitelist || []).map(normalizeEntry).filter(isValidEntry));
    if (wl.some((e) => matchUrlFilter(u, '*' + e + '^'))) return 'whitelisted';
    const bl = unique((blacklist || []).map(normalizeEntry).filter(isValidEntry));
    if (bl.some((e) => matchUrlFilter(u, '||' + e + '^'))) return 'blocked';
    return 'not-blocked';
  }

  const api = { MAX_RULES, normalizeEntry, isValidEntry, buildRules, matchUrlFilter, evaluate };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // node 单元测试
  } else {
    global.ruleBuilder = api; // service worker / 扩展页面
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);