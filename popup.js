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

  // 当前标签页正是被拦截页（block.html）时，展示专属拦截状态与提示；
  // 不展示扩展自身的 chrome-extension:// 地址
  const blockPagePrefix = chrome.runtime.getURL('block.html');
  if (url.indexOf(blockPagePrefix) === 0) {
    byId('urlBox').textContent = '（被拦截页，原始地址已隐藏）';
    byId('urlBox').title = '';
    setStatus('blocked', '🚫 此页面已被拦截');
    byId('allowCurrent').disabled = true;
    byId('allowCurrent').textContent = '该网站已被加入黑名单';
    return;
  }

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
  let data;
  try {
    data = await chrome.storage.local.get({ blacklist: [], whitelist: [], enabled: true });
  } catch (err) {
    console.error('[站点拦截器] 读取设置失败:', err);
    setStatus('neutral', '⚠ 读取设置失败…');
    return;
  }
  const state = {
    blacklist: data.blacklist || [],
    whitelist: data.whitelist || [],
    enabled: data.enabled !== false,
  };

  const toggle = byId('enabled');
  toggle.checked = state.enabled;
  toggle.addEventListener('change', async () => {
    const next = toggle.checked;
    try {
      await chrome.storage.local.set({ enabled: next });
      state.enabled = next;
      refreshStatus(state);
    } catch (err) {
      console.error('[站点拦截器] 保存设置失败:', err);
      toggle.checked = state.enabled; // 恢复为实际生效状态
      setStatus('neutral', '⚠ 保存设置失败');
    }
  });

  byId('openOptions').addEventListener('click', openOptions);

  byId('allowCurrent').addEventListener('click', async () => {
    const tab = await currentTab();
    if (!tab || !isHttpUrl(tab.url)) return;
    if (!rb) return;
    const entry = rb.normalizeEntry(tab.url);
    if (!entry || state.whitelist.includes(entry)) return;
    // 与 buildRules 截断口径一致：黑名单每条 2 条规则、白名单每条 1 条规则；已达上限时拒绝写入
    const projectedRules = state.blacklist.length * 2 + state.whitelist.length + 1;
    if (projectedRules > rb.MAX_RULES) {
      setStatus('neutral', '⚠ 规则已达上限（黑白名单规则合计 4900 条），无法加入白名单');
      return;
    }
    state.whitelist.push(entry);
    await chrome.storage.local.set({ whitelist: state.whitelist });
    byId('allowCurrent').disabled = true;
    byId('allowCurrent').textContent = '✓ 已在白名单';
    setStatus('allowed', '✅ 已加入白名单：' + entry);
  });

  refreshStatus(state);
}

main();