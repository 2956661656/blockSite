// background.js —— MV3 Service Worker
// 监听设置变化，将黑白名单同步为 declarativeNetRequest 动态规则。
// 开启(默认)时应用规则；关闭时清空全部规则（暂停拦截）。

'use strict';

importScripts('rule-builder.js');

const DEFAULT_SETTINGS = { blacklist: [], whitelist: [], enabled: true };

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

async function doSync() {
  const settings = await getSettings();
  const rules = settings.enabled
    ? ruleBuilder.buildRules(settings.blacklist, settings.whitelist).rules
    : [];
  const current = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: current.map((r) => r.id),
    addRules: rules,
  });
}

chrome.runtime.onInstalled.addListener(syncRules);
chrome.runtime.onStartup.addListener(syncRules);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.blacklist || changes.whitelist || changes.enabled)) {
    syncRules();
  }
});