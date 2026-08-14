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

// ---------- buildRules ----------
const { rules } = buildRules(['youtube.com', 'twitter.COM', 'youtube.com'], ['youtube.com/watch=1234', ' yt.edu/  ']);
assert.strictEqual(rules.length, 4, '去重后应为 4 条规则');

const blockYt = rules.find((r) => r.condition.urlFilter === '||youtube.com^');
assert.ok(blockYt, '黑名单应生成 ||youtube.com^ 规则');
assert.deepStrictEqual(blockYt.action, { type: 'block' });
assert.strictEqual(blockYt.priority, 1);
assert.ok(blockYt.condition.resourceTypes.length > 0);

assert.ok(rules.find((r) => r.condition.urlFilter === '||twitter.com^'), '应生成 ||twitter.com^ 规则');

const allowYt = rules.find((r) => r.condition.urlFilter === '*youtube.com/watch=1234^');
assert.ok(allowYt, '白名单应生成 *youtube.com/watch=1234^ 规则');
assert.deepStrictEqual(allowYt.action, { type: 'allow' });
assert.strictEqual(allowYt.priority, 2, '白名单优先级必须高于黑名单');

// id 必须唯一
const ids = rules.map((r) => r.id);
assert.strictEqual(new Set(ids).size, ids.length);

// 上限截断（5000 个不同域名）
const manyDomains = Array.from({ length: 5000 }, (_, i) => `site${i}.com`);
const { truncated, rules: capped } = buildRules(manyDomains, []);
assert.strictEqual(capped.length, rb.MAX_RULES);
assert.strictEqual(truncated, true);
assert.strictEqual(rb.MAX_RULES, 4900);

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

console.log('✅ 全部断言通过（normalize / buildRules / 边界语义 / evaluate / manifest 完整性）');