// background.js —— MV3 Service Worker
// 监听设置变化，将黑白名单同步为 declarativeNetRequest 动态规则。
// 开启(默认)时应用规则；关闭时清空全部规则（暂停拦截）。
// 被拦截的 main_frame 导航会重定向到扩展的 block.html；
// visit-anyway 消息会临时放行指定地址（10 分钟会话规则，到期自动移除）。

'use strict';

importScripts('rule-builder.js');

const DEFAULT_SETTINGS = { blacklist: [], whitelist: [], enabled: true };

const VISIT_ANYWAY_MINUTES = 10;
const VISIT_ANYWAY_PREFIX = 'visit-anyway-';
const VISIT_ANYWAY_MIN_ID = 900001;
const VISIT_ANYWAY_MAX_ID = 999999;

async function getSettings() {
  const data = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return {
    blacklist: Array.isArray(data.blacklist) ? data.blacklist : [],
    whitelist: Array.isArray(data.whitelist) ? data.whitelist : [],
    enabled: data.enabled !== false,
  };
}

// 串行化规则同步，避免并发竞态
let syncQueue = Promise.resolve();

function syncRules() {
  syncQueue = syncQueue.then(doSync).catch((err) => {
    console.error('[站点拦截器] 规则同步失败:', err);
  });
  return syncQueue;
}

// 会话规则写入队列：visit-anyway 的 id 挑选与写入必须串行，避免并发竞态
let sessionQueue = Promise.resolve();

function enqueueSessionWrite(task) {
  const run = sessionQueue.then(task, task);
  sessionQueue = run.catch(() => {});
  return run;
}

async function doSync() {
  const settings = await getSettings();
  let rules = [];
  if (settings.enabled) {
    const built = ruleBuilder.buildRules(settings.blacklist, settings.whitelist, chrome.runtime.getURL('block.html'));
    if (built.truncated) {
      console.warn('[站点拦截器] 规则已截断（超出上限）', built);
    }
    // 正则规则有硬上限且部分正则可能不受支持：先逐一预校验，剔除不支持的，避免整批原子失败
    const results = await Promise.all(
      built.rules
        .filter((r) => r.condition && r.condition.regexFilter)
        .map((r) => chrome.declarativeNetRequest
          .isRegexSupported({ regex: r.condition.regexFilter })
          .then((res) => ({ id: r.id, supported: res.isSupported })))
    );
    const unsupported = new Set(results.filter((x) => !x.supported).map((x) => x.id));
    if (unsupported.size > 0) {
      console.warn('[站点拦截器] 有 ' + unsupported.size + ' 条黑名单规则因正则不支持被跳过');
    }
    rules = built.rules.filter((r) => !unsupported.has(r.id));
  } else {
    // 关闭拦截时同时清空会话规则（visit-anyway 等），避免残留放行；
    // 清空与并发 visit-anyway 写入串行，避免 read → remove 之间插入新的会话规则
    await enqueueSessionWrite(async () => {
      const sessionRules = await chrome.declarativeNetRequest.getSessionRules();
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: sessionRules.map((r) => r.id) });
    });
  }
  const current = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: current.map((r) => r.id),
    addRules: rules,
  });
}

// 在 900001..999999 区间挑选未被占用的会话规则 id
async function pickSessionRuleId() {
  const current = await chrome.declarativeNetRequest.getSessionRules();
  const used = new Set(current.map((r) => r.id));
  let id = VISIT_ANYWAY_MIN_ID + (Date.now() % (VISIT_ANYWAY_MAX_ID - VISIT_ANYWAY_MIN_ID + 1));
  for (let i = 0; i <= VISIT_ANYWAY_MAX_ID - VISIT_ANYWAY_MIN_ID; i++) {
    if (!used.has(id)) return id;
    id = id === VISIT_ANYWAY_MAX_ID ? VISIT_ANYWAY_MIN_ID : id + 1;
  }
  throw new Error('visit-anyway: 无可用会话规则 ID');
}

// visit-anyway：为指定地址添加临时 allow 会话规则，VISIT_ANYWAY_MINUTES 分钟后自动移除
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'visit-anyway') return undefined;
  (async () => {
    // 仅支持 http(s) 网址
    if (typeof message.url !== 'string' || !/^https?:/i.test(message.url)) {
      sendResponse({ ok: false, error: '仅支持 http(s) 网址' });
      return;
    }
    const entry = ruleBuilder.normalizeEntry(message.url);
    if (!ruleBuilder.isValidEntry(entry)) {
      sendResponse({ ok: false, error: '无效的访问地址。' });
      return;
    }
    // id 挑选与规则写入都在同一队列中串行执行；先建 alarm 再写规则，失败时在 catch 里清除。
    // enabled 在队列内复查：避免「读取 enabled → 入队 → 执行」期间开关被关闭，
    // 导致禁用分支清空会话规则之后仍写入一条陈旧的 visit-anyway 放行规则
    enqueueSessionWrite(async () => {
      let ruleId;
      try {
        // 拦截关闭时不接受临时放行，避免用户在暂停状态下绕过拦截
        const settings = await getSettings();
        if (!settings.enabled) {
          sendResponse({ ok: false, error: '拦截已关闭' });
          return;
        }
        ruleId = await pickSessionRuleId();
        chrome.alarms.create(VISIT_ANYWAY_PREFIX + ruleId, { delayInMinutes: VISIT_ANYWAY_MINUTES });
        await chrome.declarativeNetRequest.updateSessionRules({
          addRules: [{
            id: ruleId,
            priority: 2,
            action: { type: 'allow' },
            condition: {
              urlFilter: '*' + entry + '^',
              resourceTypes: ruleBuilder.ALL_RESOURCE_TYPES,
            },
          }],
        });
        sendResponse({ ok: true });
      } catch (err) {
        if (ruleId) chrome.alarms.clear(VISIT_ANYWAY_PREFIX + ruleId);
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    });
  })();
  return true;
});

// 到期移除 visit-anyway 会话规则
chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(VISIT_ANYWAY_PREFIX)) return;
  const ruleId = Number(alarm.name.slice(VISIT_ANYWAY_PREFIX.length));
  if (!Number.isInteger(ruleId)) return;
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch((err) => {
    console.error('[站点拦截器] 清除 visit-anyway 会话规则失败:', err);
  });
});

chrome.runtime.onInstalled.addListener(syncRules);
chrome.runtime.onStartup.addListener(syncRules);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.blacklist || changes.whitelist || changes.enabled)) {
    syncRules();
  }
});