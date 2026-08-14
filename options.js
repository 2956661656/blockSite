// options.js —— 设置页：黑白名单管理 + 总开关

'use strict';

const state = { blacklist: [], whitelist: [], enabled: true };
const byId = (id) => document.getElementById(id);

const SECTIONS = {
  black: { storageKey: 'blacklist', label: '黑名单', inputId: 'blackInput', listId: 'blackList', formId: 'blackForm' },
  white: { storageKey: 'whitelist', label: '白名单', inputId: 'whiteInput', listId: 'whiteList', formId: 'whiteForm' },
};

let bannerTimer = null;

function showBanner(msg, isError) {
  const banner = byId('banner');
  banner.textContent = msg;
  banner.className = 'banner ' + (isError ? 'error' : 'info');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => banner.classList.add('hidden'), 3000);
}

function render() {
  renderSection('black');
  renderSection('white');
  const total = state.blacklist.length + state.whitelist.length;
  if (total >= ruleBuilder.MAX_RULES) {
    showBanner(`已达条目上限 ${ruleBuilder.MAX_RULES}，无法继续添加。`, true);
  } else if (total >= 4500) {
    showBanner(`当前共 ${total} 条，接近上限 ${ruleBuilder.MAX_RULES}，请注意控制数量。`, false);
  }
}

function renderSection(kind) {
  const sec = SECTIONS[kind];
  byId(sec.listId).replaceChildren();
  const list = state[sec.storageKey];
  byId(kind + 'Count').textContent = list.length;

  if (list.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '（暂无条目）';
    byId(sec.listId).appendChild(li);
    return;
  }
  for (const entry of list) {
    const li = document.createElement('li');
    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = entry;
    const del = document.createElement('button');
    del.className = 'ghost-btn';
    del.textContent = '删除';
    del.dataset.kind = kind;
    del.dataset.entry = entry;
    li.append(txt, del);
    byId(sec.listId).appendChild(li);
  }
}

function addEntry(kind) {
  const sec = SECTIONS[kind];
  const input = byId(sec.inputId);
  const raw = input.value;
  const entry = ruleBuilder.normalizeEntry(raw);
  const listKey = sec.storageKey;

  if (!entry) { showBanner('请输入要添加的内容。', true); return; }
  if (!ruleBuilder.isValidEntry(entry)) { showBanner('条目不能包含 * | ^ 等特殊字符。', true); return; }
  if (state[listKey].includes(entry)) { showBanner(`「${entry}」已在${sec.label}中。`, true); return; }
  if (state.blacklist.length + state.whitelist.length >= ruleBuilder.MAX_RULES) {
    showBanner(`已达条目上限 ${ruleBuilder.MAX_RULES}。`, true);
    return;
  }

  state[listKey].push(entry);
  save();
  input.value = '';
  input.focus();
  showBanner(`已添加「${entry}」到${sec.label}，规则已生效。`, false);
}

function removeEntry(kind, entry) {
  const listKey = SECTIONS[kind].storageKey;
  state[listKey] = state[listKey].filter((e) => e !== entry);
  save();
}

function save() {
  chrome.storage.local.set({ blacklist: state.blacklist, whitelist: state.whitelist });
  render();
}

function init() {
  for (const kind of ['black', 'white']) {
    const sec = SECTIONS[kind];
    byId(sec.formId).addEventListener('submit', (e) => {
      e.preventDefault();
      addEntry(kind);
    });
    byId(sec.listId).addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-kind]');
      if (btn) removeEntry(btn.dataset.kind, btn.dataset.entry);
    });
  }

  byId('enabledSwitch').addEventListener('change', (e) => {
    state.enabled = e.target.checked;
    chrome.storage.local.set({ enabled: state.enabled });
    renderToggleLabel();
  });

  // 其他页面（弹窗）改动时实时同步
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.blacklist) state.blacklist = changes.blacklist.newValue || [];
    if (changes.whitelist) state.whitelist = changes.whitelist.newValue || [];
    if (changes.enabled) {
      state.enabled = changes.enabled.newValue !== false;
      byId('enabledSwitch').checked = state.enabled;
      renderToggleLabel();
    }
    render();
  });

  chrome.storage.local.get({ blacklist: [], whitelist: [], enabled: true }, (data) => {
    state.blacklist = data.blacklist || [];
    state.whitelist = data.whitelist || [];
    state.enabled = data.enabled !== false;
    byId('enabledSwitch').checked = state.enabled;
    renderToggleLabel();
    render();
  });
}

function renderToggleLabel() {
  byId('toggleLabel').textContent = state.enabled ? '拦截已开启' : '拦截已暂停';
}

init();