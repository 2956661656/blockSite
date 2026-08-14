// popup.js —— 工具栏弹窗：总开关、当前页拦截状态、一键加白、跳转设置

'use strict';

const byId = (id) => document.getElementById(id);

// 核心模块加载失败时给出可见提示，避免界面静默失效
const rb = typeof ruleBuilder !== 'undefined' ? ruleBuilder : null;

// 打开设置页：优先新开标签页（行为确定），失败时回退到 openOptionsPage
async function openOptions() {
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  } catch (err) {
    console.warn('[站点拦截器] 新开设置页失败，尝试回退:', err);
    try {
      await chrome.runtime.openOptionsPage();
    } catch (err2) {
      console.error('[站点拦截器] 打开设置页失败:', err2);
    }
  }
}

function setStatus(kind, text) {
  const el = byId('status');
  el.className = 'status ' + kind;
  el.textContent = text;
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function isHttpUrl(url) {
  return typeof url === 'string' && /^https?:/i.test(url);
}

async function refreshStatus(state) {
  if (!state.enabled) {
    setStatus('paused', '⏸ 拦截已暂停');
    return;
  }
  const tab = await currentTab();
  const url = tab && tab.url ? tab.url : '';
  byId('urlBox').textContent = url || '（无法获取当前页面地址）';
  byId('urlBox').title = url;

  if (!isHttpUrl(url)) {
    setStatus('neutral', '⚪ 非 http(s) 页面，不参与拦截');
    byId('allowCurrent').disabled = true;
    return;
  }

  if (!rb) {
    setStatus('neutral', '⚠ 核心模块加载失败，请在扩展管理页重新加载');
    byId('allowCurrent').disabled = true;
    return;
  }
  const entry = rb.normalizeEntry(url);
  const inList = state.whitelist.includes(entry);
  const addBtn = byId('allowCurrent');
  addBtn.disabled = inList;
  addBtn.textContent = inList ? '✓ 已在白名单' : '加入白名单：当前页面';

  const result = rb.evaluate(url, state.blacklist, state.whitelist, true);
  if (result === 'whitelisted') setStatus('allowed', '🟢 白名单放行');
  else if (result === 'blocked') setStatus('blocked', '🔴 当前页面已被拦截');
  else setStatus('neutral', '⚪ 未被拦截');
}

async function main() {
  const data = await chrome.storage.local.get({ blacklist: [], whitelist: [], enabled: true });
  const state = {
    blacklist: data.blacklist || [],
    whitelist: data.whitelist || [],
    enabled: data.enabled !== false,
  };

  const toggle = byId('enabled');
  toggle.checked = state.enabled;
  toggle.addEventListener('change', async () => {
    state.enabled = toggle.checked;
    await chrome.storage.local.set({ enabled: state.enabled });
    refreshStatus(state);
  });

  byId('openOptions').addEventListener('click', openOptions);

  byId('allowCurrent').addEventListener('click', async () => {
    const tab = await currentTab();
    if (!tab || !isHttpUrl(tab.url)) return;
    if (!rb) return;
    const entry = rb.normalizeEntry(tab.url);
    if (!entry || state.whitelist.includes(entry)) return;
    state.whitelist.push(entry);
    await chrome.storage.local.set({ whitelist: state.whitelist });
    byId('allowCurrent').disabled = true;
    byId('allowCurrent').textContent = '✓ 已在白名单';
    setStatus('allowed', '✅ 已加入白名单：' + entry);
  });

  refreshStatus(state);
}

main();