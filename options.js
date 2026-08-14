// options.js —— 设置页：黑白名单管理 + 总开关 + 拦截页自定义

'use strict';

const state = { blacklist: [], whitelist: [], enabled: true, blockPage: {} };
const byId = (id) => document.getElementById(id);

const MAX_BUTTONS = 4;
const SUPPORTED_ACTIONS = ['back', 'options', 'copy', 'visitAnyway'];
const ACTION_LABELS = {
  back: '返回上一页',
  options: '打开设置',
  copy: '复制网址',
  visitAnyway: '仍然访问（10 分钟）',
};
const PRIMARY_ACTION = 'visitAnyway';
const IMAGE_LOGO_PATTERN = /^(https?:|data:|chrome-extension:)/i;
// 规则数接近上限（4900）时的提醒阈值：距离上限还有 400 条规则的空间
const NEAR_CAP_THRESHOLD = ruleBuilder.MAX_RULES - 400;

// chrome-extension: URL 仅接受本扩展自身资源（防止任意扩展资源被当作 logo）
function isImageLogo(logo) {
  if (!IMAGE_LOGO_PATTERN.test(logo)) return false;
  if (/^chrome-extension:/i.test(logo)) {
    return logo.indexOf(chrome.runtime.getURL('')) === 0;
  }
  return true;
}

const DEFAULT_BLOCK_PAGE = {
  title: '该网站已被拦截',
  message: '此网站已被列入黑名单。为了保持专注，请离开此页面。',
  showUrl: true,
  logo: '🚫',
  theme: { bg: '#0f172a', text: '#f1f5f9', accent: '#f59e0b' },
  buttons: [
    { enabled: true, text: '返回上一页', action: 'back' },
    { enabled: true, text: '仍然访问（10 分钟）', action: 'visitAnyway' },
    { enabled: false, text: '打开设置', action: 'options' },
  ],
};

const SECTIONS = {
  black: { storageKey: 'blacklist', label: '黑名单', inputId: 'blackInput', listId: 'blackList', formId: 'blackForm' },
  white: { storageKey: 'whitelist', label: '白名单', inputId: 'whiteInput', listId: 'whiteList', formId: 'whiteForm' },
};

let bannerTimer = null;
let blockPageSaveTimer = null;

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
  // 规则数而非条目数：黑名单每条产生 2 条规则（redirect + block），白名单每条产生 1 条 allow 规则
  const totalRules = state.blacklist.length * 2 + state.whitelist.length;
  if (state.blacklist.length >= ruleBuilder.MAX_REGEX_RULES) {
    showBanner('⚠ 黑名单已达 1000 条上限，超出部分不会生效。', true);
  } else if (totalRules >= ruleBuilder.MAX_RULES) {
    showBanner('黑白名单规则合计已达上限 4900 条，无法继续添加。', true);
  } else if (totalRules >= NEAR_CAP_THRESHOLD) {
    showBanner(`⚠ 黑白名单规则合计接近上限 4900 条（当前 ${totalRules} 条）`, false);
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
  if (kind === 'black' && state.blacklist.length >= ruleBuilder.MAX_REGEX_RULES) {
    showBanner('黑名单已达上限 1000 条（Chrome 正则规则硬上限），无法继续添加。', true);
    return;
  }
  // 按规则数而非条目数校验：黑名单每条 2 条规则、白名单每条 1 条规则，与 buildRules 的截断口径一致
  const projectedRules = state.blacklist.length * 2 + state.whitelist.length + (kind === 'black' ? 2 : 1);
  if (projectedRules > ruleBuilder.MAX_RULES) {
    showBanner('黑白名单规则合计已达上限 4900 条，无法继续添加。', true);
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

// ---- 拦截页自定义 ----

function isValidColor(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  // 与 block.js 一致：先拒绝 CSS 全局关键字与 var()，再走 CSS.supports
  if (/^(transparent|currentcolor|inherit|initial|unset|revert|revert-layer|var\(.*\))$/i.test(value.trim())) return false;
  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
    return CSS.supports('color', value);
  }
  return /^#[0-9a-f]{3,8}$/i.test(value.trim());
}

// WCAG 相对亮度：hex → rgb → 线性化 → 加权和（与 block.js 一致）
function relativeLuminance(hex) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  let h = match[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  const chans = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * chans[0] + 0.7152 * chans[1] + 0.0722 * chans[2];
}

// WCAG 对比度：(较亮者 + 0.05) / (较暗者 + 0.05)；非 hex 返回 null
function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// 主按钮文字色：与 block.js 的 pickButtonTextColor 一致——强调色较亮用深色文字，较暗用浅色文字；非 hex 无法计算时按默认深色处理
function pickButtonTextColor(accent) {
  const lum = relativeLuminance(accent);
  if (lum === null) return '#0f172a';
  return lum > 0.5 ? '#0f172a' : '#f8fafc';
}

// 将存储值逐字段合并在默认值之上：每个字段都可能缺失或部分非法（与 block.js 语义一致）
function mergeBlockPage(stored) {
  const source = stored && typeof stored === 'object' ? stored : {};
  const storedTheme = source.theme && typeof source.theme === 'object' ? source.theme : {};
  const buttons = Array.isArray(source.buttons)
    ? source.buttons.map((b) => ({
        enabled: b && b.enabled !== false,
        text: b && typeof b.text === 'string' ? b.text : '',
        action: b && SUPPORTED_ACTIONS.includes(b.action) ? b.action : '',
      })).filter((b) => b.text.trim() && b.action).slice(0, MAX_BUTTONS)
    : DEFAULT_BLOCK_PAGE.buttons.map((b) => ({ ...b }));

  return {
    title: typeof source.title === 'string' && source.title.trim() ? source.title : DEFAULT_BLOCK_PAGE.title,
    message: typeof source.message === 'string' && source.message.trim() ? source.message : DEFAULT_BLOCK_PAGE.message,
    showUrl: typeof source.showUrl === 'boolean' ? source.showUrl : DEFAULT_BLOCK_PAGE.showUrl,
    // logo 允许为空字符串（用户清空后保持空，避免与保存值不一致触发回写重渲染）；
    // 缺失/非字符串时仍回退默认值。block.js 在真实拦截页对空 logo 回退为默认图标。
    logo: typeof source.logo === 'string' ? source.logo.trim() : DEFAULT_BLOCK_PAGE.logo,
    theme: {
      bg: isValidColor(storedTheme.bg) ? storedTheme.bg : DEFAULT_BLOCK_PAGE.theme.bg,
      text: isValidColor(storedTheme.text) ? storedTheme.text : DEFAULT_BLOCK_PAGE.theme.text,
      accent: isValidColor(storedTheme.accent) ? storedTheme.accent : DEFAULT_BLOCK_PAGE.theme.accent,
    },
    buttons,
  };
}

function renderBlockPage() {
  const bp = state.blockPage;
  byId('bpTitle').value = bp.title;
  byId('bpMessage').value = bp.message;
  byId('bpLogo').value = bp.logo;
  byId('bpShowUrl').checked = bp.showUrl;
  byId('bpBg').value = bp.theme.bg;
  byId('bpText').value = bp.theme.text;
  byId('bpAccent').value = bp.theme.accent;
  byId('bpCount').textContent = bp.buttons.length;

  renderLogoPreview(bp.logo);
  renderButtonRows();
  updateBlockPagePreview();
}

function renderLogoPreview(logo) {
  const preview = byId('bpLogoPreview');
  preview.replaceChildren();
  if (isImageLogo(logo)) {
    const img = document.createElement('img');
    img.className = 'logo-preview-img';
    img.alt = '';
    img.src = logo;
    img.addEventListener('error', () => {
      img.remove();
      preview.textContent = '🚫';
    });
    preview.appendChild(img);
    return;
  }
  preview.textContent = logo;
}

function actionLabel(action) {
  return ACTION_LABELS[action] || action;
}

function addButtonRow(button) {
  const container = byId('bpButtons');
  const row = document.createElement('div');
  row.className = 'bp-btn-row';

  const enable = document.createElement('input');
  enable.type = 'checkbox';
  enable.className = 'bp-btn-enable';
  enable.checked = button.enabled;
  enable.dataset.field = 'enabled';

  const text = document.createElement('input');
  text.type = 'text';
  text.className = 'bp-btn-text';
  text.value = button.text;
  text.maxLength = 30;
  text.placeholder = '按钮文字';
  text.dataset.field = 'text';

  const action = document.createElement('select');
  action.className = 'bp-btn-action';
  action.dataset.field = 'action';
  for (const a of SUPPORTED_ACTIONS) {
    const opt = document.createElement('option');
    opt.value = a;
    opt.textContent = actionLabel(a);
    action.appendChild(opt);
  }
  action.value = button.action;

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'ghost-btn';
  del.textContent = '删除';
  del.addEventListener('click', () => removeButtonRow(row));

  row.append(enable, text, action, del);
  container.appendChild(row);

  enable.addEventListener('change', collectAndSave);
  text.addEventListener('input', collectAndSave);
  action.addEventListener('change', collectAndSave);
}

function removeButtonRow(row) {
  row.remove();
  collectAndSave();
}

function renderButtonRows() {
  byId('bpButtons').replaceChildren();
  for (const button of state.blockPage.buttons) {
    addButtonRow(button);
  }
  updateAddButtonVisibility();
}

// 依据 DOM 行数判断：空文本的占位行不进入状态，但同样占满 4 行上限，因此以 DOM 为准
function updateAddButtonVisibility() {
  const rowCount = byId('bpButtons').querySelectorAll('.bp-btn-row').length;
  byId('bpAddBtn').style.display = rowCount >= MAX_BUTTONS ? 'none' : '';
}

// 从 DOM 收集拦截页配置 → 状态 → 保存；再刷新预览与计数
function collectAndSave() {
  state.blockPage.title = byId('bpTitle').value.trim();
  state.blockPage.message = byId('bpMessage').value.trim();
  state.blockPage.logo = byId('bpLogo').value.trim();
  state.blockPage.showUrl = byId('bpShowUrl').checked;
  state.blockPage.theme.bg = byId('bpBg').value;
  state.blockPage.theme.text = byId('bpText').value;
  state.blockPage.theme.accent = byId('bpAccent').value;

  state.blockPage.buttons = [...byId('bpButtons').querySelectorAll('.bp-btn-row')]
    .map((row) => {
      const enable = row.querySelector('.bp-btn-enable');
      const text = row.querySelector('.bp-btn-text');
      const action = row.querySelector('.bp-btn-action');
      return {
        enabled: enable.checked,
        text: text.value.trim(),
        action: action.value,
      };
    })
    .filter((b) => b.text && b.action)
    .slice(0, MAX_BUTTONS);

  renderLogoPreview(state.blockPage.logo);
  updateBlockPagePreview();
  byId('bpCount').textContent = state.blockPage.buttons.length;
  updateAddButtonVisibility();
  // 防抖保存 blockPage，避免每次输入都触发存储写入与 onChanged 回环
  clearTimeout(blockPageSaveTimer);
  blockPageSaveTimer = setTimeout(() => {
    chrome.storage.local.set({ blockPage: state.blockPage });
  }, 200);
}

// 迷你拦截页预览：全部使用 textContent / 元素属性，杜绝 innerHTML
function updateBlockPagePreview() {
  const preview = byId('bpPreview');
  const bp = state.blockPage;

  preview.style.setProperty('--bp-bg', bp.theme.bg);
  preview.style.setProperty('--bp-text', bp.theme.text);
  preview.style.setProperty('--bp-accent', bp.theme.accent);
  preview.style.setProperty('--btn-text', pickButtonTextColor(bp.theme.accent));

  const logoEl = preview.querySelector('.bp-preview-logo');
  logoEl.replaceChildren();
  if (isImageLogo(bp.logo)) {
    const img = document.createElement('img');
    img.className = 'logo-preview-img';
    img.alt = '';
    img.src = bp.logo;
    img.addEventListener('error', () => {
      img.remove();
      logoEl.textContent = '🚫';
    });
    logoEl.appendChild(img);
  } else {
    logoEl.textContent = bp.logo;
  }

  preview.querySelector('.bp-preview-title').textContent = bp.title;
  preview.querySelector('.bp-preview-message').textContent = bp.message;

  const urlEl = preview.querySelector('.bp-preview-url');
  if (bp.showUrl) {
    urlEl.textContent = 'https://example.com/blocked-page';
    urlEl.classList.remove('hidden');
  } else {
    urlEl.classList.add('hidden');
  }

  let warnEl = preview.querySelector('.bp-warn');
  if (!warnEl) {
    warnEl = document.createElement('div');
    warnEl.className = 'bp-warn hidden';
    preview.appendChild(warnEl);
  }
  const ratio = contrastRatio(bp.theme.bg, bp.theme.text);
  if (ratio !== null && ratio < 3) {
    warnEl.textContent = '⚠ 背景与文字颜色对比度不足，可能导致无法阅读';
    warnEl.classList.remove('hidden');
  } else {
    warnEl.classList.add('hidden');
  }

  const buttonsEl = preview.querySelector('.bp-preview-buttons');
  buttonsEl.replaceChildren();
  let rendered = 0;
  for (const button of bp.buttons) {
    if (!button.enabled || !button.text || rendered >= MAX_BUTTONS) continue;
    const el = document.createElement('span');
    el.className = 'bp-preview-btn' + (button.action === PRIMARY_ACTION ? ' primary' : ' ghost');
    el.textContent = button.text;
    buttonsEl.appendChild(el);
    rendered++;
  }
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

  // 拦截页字段：输入即收集保存并刷新预览
  for (const id of ['bpTitle', 'bpMessage', 'bpLogo']) {
    byId(id).addEventListener('input', collectAndSave);
  }
  byId('bpShowUrl').addEventListener('change', collectAndSave);
  for (const id of ['bpBg', 'bpText', 'bpAccent']) {
    byId(id).addEventListener('input', collectAndSave);
  }

  byId('bpAddBtn').addEventListener('click', () => {
    if (byId('bpButtons').querySelectorAll('.bp-btn-row').length >= MAX_BUTTONS) return;
    // 占位行只进 DOM 不进状态：未填文字时 collectAndSave 会过滤掉，重载后只保留真实按钮行
    addButtonRow({ enabled: true, text: '', action: SUPPORTED_ACTIONS[0] });
    updateAddButtonVisibility();
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
    if (changes.blockPage) {
      const next = mergeBlockPage(changes.blockPage.newValue);
      // 仅在新值与当前状态实质不同时重渲染，避免自身保存触发的 onChanged 回环
      if (JSON.stringify(next) !== JSON.stringify(state.blockPage)) {
        state.blockPage = next;
        renderBlockPage();
      }
    }
    if (changes.blacklist || changes.whitelist || changes.enabled) {
      render();
    }
  });

  chrome.storage.local.get({ blacklist: [], whitelist: [], enabled: true, blockPage: DEFAULT_BLOCK_PAGE }, (data) => {
    state.blacklist = data.blacklist || [];
    state.whitelist = data.whitelist || [];
    state.enabled = data.enabled !== false;
    state.blockPage = mergeBlockPage(data.blockPage);
    byId('enabledSwitch').checked = state.enabled;
    renderToggleLabel();
    renderBlockPage();
    render();
  });
}

function renderToggleLabel() {
  byId('toggleLabel').textContent = state.enabled ? '拦截已开启' : '拦截已暂停';
}

init();