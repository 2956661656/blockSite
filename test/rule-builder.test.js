// rule-builder 单元测试 + manifest 完整性校验（node 内置 assert，无第三方依赖）
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const rb = require('../rule-builder.js');
const { normalizeEntry, isValidEntry, buildRules, matchUrlFilter, evaluate } = rb;

const root = path.join(__dirname, '..');

// ---------- normalizeEntry ----------
assert.strictEqual(normalizeEntry(' https://www.YouTube.COM/watch=1234/ '), 'youtube.com/watch=1234');
assert.strictEqual(normalizeEntry('youtube.com'), 'youtube.com');
assert.strictEqual(normalizeEntry('HTTPS://EXAMPLE.COM/A#frag'), 'example.com/a');
assert.strictEqual(normalizeEntry(''), '');
assert.strictEqual(normalizeEntry('   '), '');
assert.strictEqual(normalizeEntry('www.badsite.org'), 'badsite.org');

// ---------- isValidEntry ----------
assert.strictEqual(isValidEntry('youtube.com/watch=1234'), true);
assert.strictEqual(isValidEntry('youtube.com*watch'), false);
assert.strictEqual(isValidEntry('a|b'), false);
assert.strictEqual(isValidEntry('a^b'), false);
assert.strictEqual(isValidEntry(''), false);
// 仅支持 ASCII（中文域名须用 punycode，否则 DNR 更新原子失败会导致全部规则失效）
assert.strictEqual(isValidEntry('例子.中国'), false);
assert.strictEqual(isValidEntry('xn--fsqu00a.xn--fiqs8s'), true);
assert.strictEqual(isValidEntry('youtube.com'), true);

// ---------- buildRules（3 参签名：blockPageUrl 必填） ----------
const BLOCK_PAGE = 'chrome-extension://abcdefghijklmnop/block.html';

// blockPageUrl 缺失 / undefined / null / 空字符串 → TypeError
assert.throws(() => buildRules(['youtube.com'], []), TypeError);
assert.throws(() => buildRules(['youtube.com'], [], undefined), TypeError);
assert.throws(() => buildRules(['youtube.com'], [], null), TypeError);
assert.throws(() => buildRules(['youtube.com'], [], ''), TypeError);

// 2 个去重后黑名单条目（youtube.com / twitter.com）× 2 条规则 + 2 个白名单条目 × 1 条 = 6 条
const built = buildRules(['youtube.com', 'twitter.COM', 'youtube.com'], ['youtube.com/watch=1234', ' yt.edu/  '], BLOCK_PAGE);
assert.strictEqual(built.rules.length, 6, '去重后应生成 6 条规则');
assert.strictEqual(built.totalEntries, 4);
assert.strictEqual(built.blacklistCount, 2);
assert.strictEqual(built.whitelistCount, 2);
assert.strictEqual(built.truncated, false);

// redirect 规则：id 1..N，仅 main_frame，重定向到 blockPageUrl + '#\0'
const redirectYt = built.rules.find(
  (r) => r.condition.regexFilter && r.condition.resourceTypes.length === 1 && r.condition.resourceTypes[0] === 'main_frame' && r.id === 1
);
assert.ok(redirectYt, '黑名单应生成 main_frame redirect 规则（id=1）');
assert.strictEqual(redirectYt.action.type, 'redirect');
assert.strictEqual(redirectYt.action.redirect.regexSubstitution, BLOCK_PAGE + '#\\0');
assert.strictEqual(redirectYt.priority, 1);

// block 规则：其余资源类型拦截，不含 main_frame
const blockYt = built.rules.find((r) => r.condition.urlFilter === '||youtube.com^');
assert.ok(blockYt, '黑名单应生成 ||youtube.com^ 规则');
assert.deepStrictEqual(blockYt.action, { type: 'block' });
assert.strictEqual(blockYt.priority, 1);
assert.ok(blockYt.condition.resourceTypes.length > 0);
assert.ok(!blockYt.condition.resourceTypes.includes('main_frame'), 'block 规则不应包含 main_frame');
assert.strictEqual(blockYt.id, 1001);

assert.ok(built.rules.find((r) => r.condition.urlFilter === '||twitter.com^'), '应生成 ||twitter.com^ 规则');

// allow 规则：白名单条目放行，优先级 2，覆盖全部资源类型
const allowYt = built.rules.find((r) => r.condition.urlFilter === '*youtube.com/watch=1234^');
assert.ok(allowYt, '白名单应生成 *youtube.com/watch=1234^ 规则');
assert.deepStrictEqual(allowYt.action, { type: 'allow' });
assert.strictEqual(allowYt.priority, 2, '白名单优先级必须高于黑名单');
assert.ok(allowYt.condition.resourceTypes.includes('main_frame'));
assert.ok(allowYt.condition.resourceTypes.includes('sub_frame'));
assert.ok(allowYt.condition.resourceTypes.includes('image'));
assert.strictEqual(allowYt.id, 2001);

assert.ok(built.rules.find((r) => r.condition.urlFilter === '*yt.edu^'), '应生成 *yt.edu^ 规则');

// id 必须唯一
const ids = built.rules.map((r) => r.id);
assert.strictEqual(new Set(ids).size, ids.length);

// \0 完整 URL 捕获：正则必须匹配整条 URL（regexSubstitution 才能回填完整地址）
const re = new RegExp(rb.toRegexFilter('youtube.com'));
assert.strictEqual(re.exec('https://www.youtube.com/watch=12345')[0], 'https://www.youtube.com/watch=12345');
assert.strictEqual(re.exec('https://m.youtube.com/feed')[0], 'https://m.youtube.com/feed');
assert.strictEqual(re.exec('https://notyoutube.com/'), null);
assert.strictEqual(re.exec('https://youtube.com.evil.com/'), null);

// 正则边界语义：域名锚点（||）匹配裸域名与子域名，不误伤前缀/后缀
assert.ok(re.exec('http://youtube.com'), '裸域名 http://youtube.com 应命中');
assert.strictEqual(re.exec('https://evilyoutube.com/'), null);

// 上限截断：正则规则硬上限 1000（每黑名单条目恰好 1 条正则 → 2000 条规则）
const d1001 = Array.from({ length: 1001 }, (_, i) => `site${i}.com`);
const cappedRegex = buildRules(d1001, [], BLOCK_PAGE);
assert.strictEqual(cappedRegex.blacklistCount, 1000);
assert.strictEqual(cappedRegex.truncated, true);
assert.strictEqual(cappedRegex.rules.length, 2000);
assert.strictEqual(rb.MAX_REGEX_RULES, 1000);

// 边界 id：黑名单恰好 1000 条时最后一条 block 规则 id=2000，白名单从 2001 起，无冲突
const thousandBl = Array.from({ length: 1000 }, (_, i) => `site${i}.com`);
const boundary = buildRules(thousandBl, ['yt.edu'], BLOCK_PAGE);
const boundaryIds = boundary.rules.map((r) => r.id);
assert.strictEqual(new Set(boundaryIds).size, boundaryIds.length, '边界处 id 不得冲突');
const lastBlockBoundary = boundary.rules.find((r) => r.id === 2000);
assert.ok(lastBlockBoundary, '黑名单第 1000 条应生成 id=2000 的 block 规则');
assert.strictEqual(lastBlockBoundary.condition.urlFilter, '||site999.com^');
const allowBoundary = boundary.rules.find((r) => r.id === 2001);
assert.ok(allowBoundary, '白名单应分配 id=2001 的 allow 规则（不与黑名单冲突）');
assert.strictEqual(allowBoundary.condition.urlFilter, '*yt.edu^');
assert.strictEqual(boundary.rules.length, 2001);

// 总上限 MAX_RULES：5000 黑名单 + 5000 白名单 → 合计 4900 条封顶
const fiveThousand = Array.from({ length: 5000 }, (_, i) => `site${i}.com`);
const cappedTotal = buildRules(fiveThousand, fiveThousand, BLOCK_PAGE);
assert.strictEqual(cappedTotal.rules.length, rb.MAX_RULES, '规则总数不得超过 4900');
assert.strictEqual(cappedTotal.rules.length, 4900);
assert.strictEqual(cappedTotal.truncated, true);
assert.strictEqual(cappedTotal.whitelistCount, 2900, '黑名单占 2000 条规则后，白名单最多再占 2900 条');
assert.strictEqual(cappedTotal.totalEntries, 10000);
assert.strictEqual(rb.MAX_RULES, 4900);

// 空输入
const emptyBuilt = buildRules([], [], BLOCK_PAGE);
assert.strictEqual(emptyBuilt.rules.length, 0);
assert.strictEqual(emptyBuilt.truncated, false);

// 空黑名单 + 非空白名单：仅生成 allow 规则，id 从 2001 起
const onlyWhite = buildRules([], ['yt.edu'], BLOCK_PAGE);
assert.strictEqual(onlyWhite.rules.length, 1);
assert.strictEqual(onlyWhite.rules[0].id, 2001);
assert.strictEqual(onlyWhite.rules[0].condition.urlFilter, '*yt.edu^');
assert.strictEqual(onlyWhite.truncated, false);
assert.strictEqual(onlyWhite.blacklistCount, 0);
assert.strictEqual(onlyWhite.whitelistCount, 1);

// 白名单重复条目去重（含大小写/空白/斜杠差异）
const dupWhite = buildRules([], ['yt.edu', ' YT.EDU/ ', 'yt.edu'], BLOCK_PAGE);
assert.strictEqual(dupWhite.rules.length, 1);
assert.strictEqual(dupWhite.whitelistCount, 1);

// null / undefined 黑白名单：按空数组处理，不抛异常
const nullBuilt = buildRules(null, undefined, BLOCK_PAGE);
assert.strictEqual(nullBuilt.rules.length, 0);
assert.strictEqual(nullBuilt.truncated, false);
assert.strictEqual(nullBuilt.blacklistCount, 0);
assert.strictEqual(nullBuilt.whitelistCount, 0);

// ---------- matchUrlFilter 边界语义 ----------
// 域名锚点：不匹配 badexample.com
assert.strictEqual(matchUrlFilter('https://badexample.com/', '||example.com^'), false);
assert.strictEqual(matchUrlFilter('https://notyoutube.com/', '||youtube.com^'), false);
// 匹配子域名与裸域名
assert.strictEqual(matchUrlFilter('https://www.youtube.com/path', '||youtube.com^'), true);
assert.strictEqual(matchUrlFilter('https://m.youtube.com/', '||youtube.com^'), true);
assert.strictEqual(matchUrlFilter('http://youtube.com', '||youtube.com^'), true);
// 域名后缀不误伤
assert.strictEqual(matchUrlFilter('https://youtube.com.evil.com/', '||youtube.com^'), false);
assert.strictEqual(matchUrlFilter('https://example.com/?q=youtube.com', '||youtube.com^'), false);
// 严格边界：watch=1234 不放行 watch=12345
assert.strictEqual(matchUrlFilter('https://youtube.com/watch=12345', '*youtube.com/watch=1234^'), false);
// 允许后续参数
assert.strictEqual(matchUrlFilter('https://youtube.com/watch=1234&t=60', '*youtube.com/watch=1234^'), true);
assert.strictEqual(matchUrlFilter('https://youtube.com/watch=1234', '*youtube.com/watch=1234^'), true);

// ---------- evaluate 综合场景 ----------
const BL = ['youtube.com'];
const WL = ['youtube.com/watch=1234'];

assert.strictEqual(evaluate('https://www.youtube.com/', BL, WL, true), 'blocked');
assert.strictEqual(evaluate('https://m.youtube.com/watch=12345', BL, WL, true), 'blocked');
assert.strictEqual(evaluate('https://youtube.com/feed/subscriptions', BL, WL, true), 'blocked');
assert.strictEqual(evaluate('https://www.youtube.com/watch=1234', BL, WL, true), 'whitelisted');
assert.strictEqual(evaluate('https://www.youtube.com/watch=1234&t=60', BL, WL, true), 'whitelisted');
assert.strictEqual(evaluate('http://youtube.com/watch=1234', BL, WL, true), 'whitelisted');
// 白名单是子串匹配（无域名锚点）：命中 allow 规则即放行，与 DNR 行为一致
assert.strictEqual(evaluate('https://notyoutube.com/watch=1234', BL, WL, true), 'whitelisted');
assert.strictEqual(evaluate('https://youtube.com.evil.com/', BL, WL, true), 'not-blocked');
assert.strictEqual(evaluate('https://example.com/', BL, WL, true), 'not-blocked');
// 关闭开关 → 全部放行
assert.strictEqual(evaluate('https://youtube.com/', BL, WL, false), 'not-blocked');
// www. 归一化后仍能拦截
assert.strictEqual(evaluate('https://www.youtube.com/watch=1', ['www.youtube.com'], [], true), 'blocked');
// 黑白名单相同域名 → 全部放行
assert.strictEqual(evaluate('https://youtube.com/anything', ['youtube.com'], ['youtube.com'], true), 'whitelisted');

// ---------- manifest 及引用文件完整性 ----------
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
assert.strictEqual(manifest.manifest_version, 3);
const refs = [
  manifest.background.service_worker,
  manifest.options_ui.page,
  manifest.action.default_popup,
  ...Object.values(manifest.icons),
];
for (const f of refs) {
  assert.ok(fs.existsSync(path.join(root, f)), `manifest 引用的文件缺失: ${f}`);
}
// 权限齐备
for (const perm of ['declarativeNetRequest', 'storage', 'tabs', 'alarms']) {
  assert.ok(manifest.permissions.includes(perm), `manifest.permissions 缺少 ${perm}`);
}
// block.html 必须作为 web_accessible_resources 暴露，供被拦截网页重定向访问
const war = manifest.web_accessible_resources || [];
assert.ok(
  war.some(
    (e) =>
      Array.isArray(e.resources) &&
      e.resources.includes('block.html') &&
      Array.isArray(e.matches) &&
      e.matches.includes('*://*/*')
  ),
  'web_accessible_resources 应暴露 block.html（matches: *://*/*）'
);
assert.ok(fs.existsSync(path.join(root, 'block.html')), 'block.html 缺失');

console.log('✅ 全部断言通过（normalize / isValidEntry(ASCII+punycode) / buildRules(3参+截断) / \\0 全 URL 捕获 / 边界语义 / evaluate / manifest 完整性）');