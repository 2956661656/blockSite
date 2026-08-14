// block.js —— 被拦截页面
// DNR 重定向时把原始 URL 放进 fragment（block.html#<url>），这里恢复它并渲染拦截页。
// 本页是 web_accessible 资源，所有文本一律用 textContent 渲染，杜绝 innerHTML。
// 设置读取 chrome.storage.local 的 blockPage 键（Phase 3 提供自定义），缺失/部分字段用默认值兜底。

'use strict';

const byId = (id) => document.getElementById(id);

const MAX_BUTTONS = 4;
const SUPPORTED_ACTIONS = new Set(['back', 'options', 'copy', 'visitAnyway']);
const PRIMARY_ACTION = 'visitAnyway';
const IMAGE_LOGO_PATTERN = /^(https?:|data:|chrome-extension:)/i;
const HTTP_URL_PATTERN = /^https?:/i;

const DEFAULT_BLOCK_PAGE = {
  title: '该网站已被拦截',
  message: '此网站已被列入黑名单。为了保持专注，请离开此页面。',
  showUrl: true,
  logo: '🚫',
  // 留空表示使用默认深色背景（不加载任何背景图片）
  backgroundImage: '',
  theme: { bg: '#0f172a', text: '#f1f5f9', accent: '#f59e0b' },
  buttons: [
    { enabled: true, text: '返回上一页', action: 'back' },
    { enabled: true, text: '仍然访问（10 分钟）', action: 'visitAnyway' },
    { enabled: false, text: '打开设置', action: 'options' },
  ],
};

// 注意：DNR regexFilter 匹配的是网络请求 URL（不含 fragment），因此被拦截地址自身携带的
// '#fragment' 不会保留；这里恢复的是重定向时写入 fragment 的完整原始 URL。
// 先捕获 fragment 里的原始 URL，再从地址栏抹掉它（replaceState 会丢掉 hash）
const originalUrl = location.hash.slice(1);
const hasOriginalUrl = originalUrl.length > 0;

if (hasOriginalUrl) {
  try {
    history.replaceState('', document.title, location.pathname);
  } catch (err) {
    // 极少数上下文不允许 replaceState 时静默忽略，不影响页面渲染
  }
}

function isHttpUrl(url) {
  return typeof url === 'string' && HTTP_URL_PATTERN.test(url);
}

// 图片 URL 校验（logo 与背景图共用）：http(s)/data:/本扩展资源；
// chrome-extension: 仅接受本扩展自身资源（防止任意扩展资源被当作 logo / 背景图）
function isValidImageUrl(value) {
  if (typeof value !== 'string' || !IMAGE_LOGO_PATTERN.test(value)) return false;
  if (/^chrome-extension:/i.test(value)) {
    return value.indexOf(chrome.runtime.getURL('')) === 0;
  }
  return true;
}

function isImageLogo(logo) {
  return isValidImageUrl(logo);
}

function isValidColor(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  // 先拒绝 CSS 全局关键字与 var()，避免它们绕过校验造成退化颜色
  if (/^(transparent|currentcolor|inherit|initial|unset|revert|revert-layer|var\(.*\))$/i.test(value.trim())) return false;
  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
    return CSS.supports('color', value);
  }
  return /^#[0-9a-f]{3,8}$/i.test(value.trim());
}

// 由主题文字色推导次级文字色：hex 直接转 rgba(60%) 保证全环境可用，其余格式交给 color-mix
function mutedColor(textColor) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(textColor.trim());
  if (match) {
    let hex = match[1];
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    const n = parseInt(hex, 16);
    return 'rgba(' + ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ', 0.6)';
  }
  return 'color-mix(in srgb, ' + textColor + ' 60%, transparent)';
}

function normalizeButtons(buttons) {
  if (!Array.isArray(buttons)) return DEFAULT_BLOCK_PAGE.buttons;
  const result = [];
  for (const item of buttons) {
    if (result.length >= MAX_BUTTONS) break;
    if (!item || typeof item !== 'object') continue;
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    const action = SUPPORTED_ACTIONS.has(item.action) ? item.action : '';
    if (!text || !action) continue;
    result.push({ enabled: item.enabled !== false, text, action });
  }
  // 存储值虽是数组但没有一条有效按钮时回退默认按钮，避免空白页
  return result.length > 0 ? result : DEFAULT_BLOCK_PAGE.buttons;
}

// 背景图归一化：非字符串 → ''；空字符串保留 ''（表示使用默认深色背景）；非空无效 URL → ''
function normalizeBackgroundImage(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return isValidImageUrl(trimmed) ? trimmed : '';
}

// 将存储值逐字段合并在默认值之上：每个字段都可能缺失或部分非法
function mergeSettings(stored) {
  const source = stored && typeof stored === 'object' ? stored : {};
  const storedTheme = source.theme && typeof source.theme === 'object' ? source.theme : {};
  return {
    title: typeof source.title === 'string' && source.title.trim() ? source.title : DEFAULT_BLOCK_PAGE.title,
    message: typeof source.message === 'string' && source.message.trim() ? source.message : DEFAULT_BLOCK_PAGE.message,
    showUrl: typeof source.showUrl === 'boolean' ? source.showUrl : DEFAULT_BLOCK_PAGE.showUrl,
    logo: typeof source.logo === 'string' && source.logo.trim() ? source.logo : DEFAULT_BLOCK_PAGE.logo,
    backgroundImage: normalizeBackgroundImage(source.backgroundImage),
    theme: {
      bg: isValidColor(storedTheme.bg) ? storedTheme.bg : DEFAULT_BLOCK_PAGE.theme.bg,
      text: isValidColor(storedTheme.text) ? storedTheme.text : DEFAULT_BLOCK_PAGE.theme.text,
      accent: isValidColor(storedTheme.accent) ? storedTheme.accent : DEFAULT_BLOCK_PAGE.theme.accent,
    },
    buttons: normalizeButtons(source.buttons),
  };
}

// 相对亮度（WCAG）：hex → rgb → 线性化 → 加权和；非 hex 返回 null
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

// 主按钮文字色：强调色较亮用深色文字，较暗用浅色文字；非 hex 无法计算时按默认深色处理
function pickButtonTextColor(accent) {
  const lum = relativeLuminance(accent);
  if (lum === null) return '#0f172a';
  return lum > 0.5 ? '#0f172a' : '#f8fafc';
}

function applyTheme(theme) {
  const root = document.documentElement;
  root.style.setProperty('--bg', theme.bg);
  root.style.setProperty('--text', theme.text);
  root.style.setProperty('--accent', theme.accent);
  root.style.setProperty('--muted', mutedColor(theme.text));
  root.style.setProperty('--btn-text', pickButtonTextColor(theme.accent));
}

// 把已验证的图片 URL 包成 CSS url() 值（转义反斜杠与双引号，避免破坏样式表）
function cssUrlValue(url) {
  return 'url("' + url.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '")';
}

// 背景图先预加载，成功后再挂载（失败静默回退默认深色背景，不阻塞页面渲染）
function applyBackgroundImage(backgroundImage) {
  const root = document.documentElement;
  const body = document.body;
  const clearBackgroundImage = () => {
    body.classList.remove('has-bg-image');
    root.style.removeProperty('--bp-bg-image');
  };

  if (!isValidImageUrl(backgroundImage)) {
    clearBackgroundImage();
    return;
  }

  const img = new Image();
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('load', () => {
    root.style.setProperty('--bp-bg-image', cssUrlValue(backgroundImage));
    body.classList.add('has-bg-image');
  });
  img.addEventListener('error', clearBackgroundImage);
  img.src = backgroundImage;
}

function renderLogo(logo) {
  const container = byId('logo');
  if (isImageLogo(logo)) {
    const img = document.createElement('img');
    img.className = 'logo-img';
    img.src = logo;
    img.alt = '';
    img.addEventListener('error', () => {
      img.remove();
      container.textContent = DEFAULT_BLOCK_PAGE.logo;
    });
    container.replaceChildren(img);
    return;
  }
  container.textContent = logo;
}

function renderButtons(buttons) {
  const container = byId('buttons');
  const fragment = document.createDocumentFragment();
  let rendered = 0;
  for (const button of buttons) {
    if (!button.enabled || !button.text || rendered >= MAX_BUTTONS) continue;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'btn ' + (button.action === PRIMARY_ACTION ? 'btn-primary' : 'btn-ghost');
    el.dataset.action = button.action;
    el.textContent = button.text;
    // copy / visitAnyway 依赖原始 URL；无 URL 或非 http(s)（直接打开本页）时优雅禁用
    if ((button.action === 'copy' || button.action === 'visitAnyway') && (!hasOriginalUrl || !isHttpUrl(originalUrl))) {
      el.disabled = true;
    }
    el.addEventListener('click', () => handleAction(button.action));
    fragment.appendChild(el);
    rendered++;
  }
  container.replaceChildren(fragment);
}

function render(settings) {
  applyTheme(settings.theme);
  applyBackgroundImage(settings.backgroundImage);
  renderLogo(settings.logo);
  byId('title').textContent = settings.title;
  byId('message').textContent = settings.message;
  if (settings.showUrl && hasOriginalUrl) {
    byId('urlBox').textContent = originalUrl;
    byId('urlBox').classList.remove('hidden');
  }
  renderButtons(settings.buttons);
  document.body.classList.add('ready');
}

function renderDefaults() {
  try {
    render(mergeSettings(null));
  } catch (err) {
    // 兜底渲染自身失败时，确保关键文本可见，绝不留下空白页
    const titleEl = byId('title');
    if (titleEl) titleEl.textContent = DEFAULT_BLOCK_PAGE.title;
    const messageEl = byId('message');
    if (messageEl) messageEl.textContent = DEFAULT_BLOCK_PAGE.message;
  }
  document.body.classList.add('ready');
}

function showMessage(text) {
  byId('message').textContent = text;
}

function handleBack() {
  if (history.length > 1) {
    history.back();
    return;
  }
  try {
    chrome.tabs.create({});
    chrome.tabs.getCurrent((tab) => {
      if (tab) chrome.tabs.remove(tab.id);
    });
  } catch (err) {
    // 无法新开标签页时保留当前页，不做额外处理
  }
}

function handleOptions() {
  try {
    chrome.runtime.openOptionsPage();
  } catch (err) {
    console.error('[站点拦截器] 打开设置页失败:', err);
  }
}

function handleCopy() {
  if (!hasOriginalUrl) return;
  try {
    navigator.clipboard.writeText(originalUrl).catch(() => {});
  } catch (err) {
    // 剪贴板不可用时静默失败
  }
}

function handleVisitAnyway() {
  if (!hasOriginalUrl || !isHttpUrl(originalUrl)) return;
  try {
    chrome.runtime.sendMessage({ type: 'visit-anyway', url: originalUrl }, (response) => {
      if (chrome.runtime.lastError) {
        showMessage('暂时放行失败，请稍后再试。');
        return;
      }
      if (response && response.ok) {
        try {
          location.replace(originalUrl);
        } catch (err) {
          showMessage('暂时放行失败，请稍后再试。');
        }
        return;
      }
      showMessage('暂时放行失败，请稍后再试。');
    });
  } catch (err) {
    showMessage('暂时放行失败，请稍后再试。');
  }
}

function handleAction(action) {
  switch (action) {
    case 'back': handleBack(); break;
    case 'options': handleOptions(); break;
    case 'copy': handleCopy(); break;
    case 'visitAnyway': handleVisitAnyway(); break;
    default: break;
  }
}

function init() {
  try {
    chrome.storage.local.get({ blockPage: DEFAULT_BLOCK_PAGE }, (data) => {
      try {
        render(mergeSettings(data.blockPage));
      } catch (err) {
        console.error('[站点拦截器] 渲染拦截页失败:', err);
        renderDefaults();
      }
    });
  } catch (err) {
    console.error('[站点拦截器] 读取设置失败:', err);
    renderDefaults();
  }
}

init();
