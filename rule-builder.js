// rule-builder.js —— 纯函数模块（不依赖任何 chrome API）
// 黑白名单条目 → declarativeNetRequest 动态规则；同时提供匹配判定供弹窗/测试使用。
//
// 匹配语义（与 DNR urlFilter 保持一致）：
//   - 黑名单条目 D    → 每条生成两条规则：
//       · redirect（main_frame）：正则 toRegexFilter(D)，语义与 "||D^" 一致，重定向到 blockPageUrl
//       · block（其余资源类型）：urlFilter "||D^"
//   - 白名单条目 U    → urlFilter "*U^"    严格·路径边界：URL 包含 U 且其后是分隔符或结尾
//   - 白名单优先级(2) > 黑名单优先级(1)，命中白名单即放行
//
//  例：黑名单 "youtube.com" + 白名单 "youtube.com/watch=1234"
//      → 放行 youtube.com/watch=1234 及 watch=1234&t=60
//      → main_frame 重定向到 block 页、其余资源拦截 youtube.com/watch=12345、youtube.com 任意其他页面

'use strict';

(function (global) {
  // DNR 动态规则上限为 5000（unsafe），留出余量
  const MAX_RULES = 4900;

  // Chrome 对 regex 规则数量的硬上限；每条黑名单条目恰好产生 1 条 redirect 正则规则
  const MAX_REGEX_RULES = 1000;

  const ALL_RESOURCE_TYPES = [
    'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
    'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket',
    'webtransport', 'webbundle', 'other',
  ];

  // main_frame 由 redirect 规则接管，其余资源类型沿用原生拦截
  const NON_MAIN_FRAME_TYPES = ALL_RESOURCE_TYPES.filter((t) => t !== 'main_frame');

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

  // DNR 要求 urlFilter/regexFilter 仅含 ASCII（中文域名需使用 punycode 形式），
  // 否则 updateDynamicRules 原子失败会导致全部规则失效。
  function isValidEntry(entry) {
    return entry.length > 0 && !FORBIDDEN.test(entry) && !/[^\x00-\x7F]/.test(entry);
  }

  function unique(list) {
    return [...new Set(list)];
  }

  // 转义正则元字符，使条目在 regexFilter 中按字面量匹配
  function regexEscape(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // 将条目编译为正则，精确复刻 urlFilter "||entry^" 的语义（域名锚点 + 严格边界），仅限 http(s)：
  //   - (?:[^/?#]+\.)*  零个或多个主机标签 + 点（域名锚点，等同「||」）
  //   - 尾部 (?:[^a-zA-Z0-9_.%-]|$)  等同 DNR 的「^」边界
  function toRegexFilter(entry) {
    // 尾部追加 .*：让正则匹配完整 URL，使 regexSubstitution 的 \0 能捕获整条地址
    return '^https?://(?:[^/?#]+\\.)*' + regexEscape(entry) + '(?:[^a-zA-Z0-9_.%-]|$).*';
  }

  function makeBlockRule(id, entry) {
    return {
      id,
      priority: 1,
      action: { type: 'block' },
      condition: { urlFilter: '||' + entry + '^', resourceTypes: NON_MAIN_FRAME_TYPES },
    };
  }

  function makeAllowRule(id, entry) {
    return {
      id,
      priority: 2,
      action: { type: 'allow' },
      condition: { urlFilter: '*' + entry + '^', resourceTypes: ALL_RESOURCE_TYPES },
    };
  }

  function makeRedirectRule(id, entry, blockPageUrl) {
    return {
      id,
      priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: blockPageUrl + '#\\0' } },
      condition: { regexFilter: toRegexFilter(entry), resourceTypes: ['main_frame'] },
    };
  }

  // 构建动态规则列表：
  //   - 黑名单条目 → redirect(id 1..N, main_frame) + block(id 1001..1000+N, 其余类型)
  //   - 白名单条目 → allow(id 2001..2000+M)
  // blockPageUrl 必填（如 'chrome-extension://<id>/block.html'）。
  function buildRules(blacklist, whitelist, blockPageUrl) {
    if (typeof blockPageUrl !== 'string' || blockPageUrl.length === 0) {
      throw new TypeError('buildRules: blockPageUrl 必填（如 chrome-extension://<id>/block.html）');
    }
    const bl = unique((blacklist || []).map(normalizeEntry).filter(isValidEntry));
    const wl = unique((whitelist || []).map(normalizeEntry).filter(isValidEntry));

    const rules = [];

    const blacklistCount = Math.min(bl.length, MAX_REGEX_RULES);
    for (let i = 0; i < blacklistCount; i++) {
      rules.push(makeRedirectRule(i + 1, bl[i], blockPageUrl));
      rules.push(makeBlockRule(1001 + i, bl[i]));
    }

    let whitelistCount = 0;
    for (const u of wl) {
      if (rules.length >= MAX_RULES) break;
      rules.push(makeAllowRule(2001 + whitelistCount, u));
      whitelistCount++;
    }

    const truncated = blacklistCount < bl.length || whitelistCount < wl.length;
    return {
      rules,
      truncated,
      totalEntries: bl.length + wl.length,
      blacklistCount,
      whitelistCount,
    };
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

  const api = {
    MAX_RULES,
    MAX_REGEX_RULES,
    ALL_RESOURCE_TYPES,
    NON_MAIN_FRAME_TYPES,
    normalizeEntry,
    isValidEntry,
    regexEscape,
    toRegexFilter,
    buildRules,
    matchUrlFilter,
    evaluate,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // node 单元测试
  } else {
    global.ruleBuilder = api; // service worker / 扩展页面
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
