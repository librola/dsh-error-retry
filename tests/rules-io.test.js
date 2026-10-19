import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// 通过字符串替换在工厂内部注入导出，产物本身不保留任何测试钩子。
function loadInternals() {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const marker = "    return {\n      inject: ['slots', 'locale', 'configForms'],";
  assert.ok(source.includes(marker), '客户端结构已变化，需更新测试注入点');
  const instrumented = source.replace(marker,
    '    return {\n      __test: { serializeRules, parseRulesFile, importRulesIntoDraft, RULES_FILE_NAME, MAX_IMPORT_CHARS },\n      inject: [\'slots\', \'locale\', \'configForms\'],');
  let loaded;
  runInNewContext(instrumented, {
    window: { __ModuleLoader__: { load(value) { loaded = value; } } },
  });
  assert.ok(loaded, '客户端未按模块加载器格式注册');
  // 工厂只建立闭包，不触碰 React 渲染路径。
  const api = loaded.factory(() => ({}));
  assert.ok(api.__test, '内部函数注入失败');
  return { internals: api.__test, source };
}

const { internals, source } = loadInternals();
// vm 里的对象来自另一个 realm，比较前转成本 realm 的普通 JSON 值。
const plain = value => JSON.parse(JSON.stringify(value));

const VALID_RULES = [
  { mode: 'contains', pattern: 'Temporary service unavailable.' },
  { mode: 'regex', pattern: '^Request rate limit exceeded\\.', flags: 'i' },
];

test('导出结构固定为 version 与 rules，并补全 flags', () => {
  const rules = [
    { mode: 'contains', pattern: 'Temporary service unavailable.' },
    { mode: 'regex', pattern: '^Request rate limit exceeded\\.', flags: 'i' },
    { mode: 'regex', pattern: 'BUSY' },
  ];
  assert.deepEqual(plain(internals.serializeRules(rules)), {
    version: 1,
    rules: [
      { mode: 'contains', pattern: 'Temporary service unavailable.' },
      { mode: 'regex', pattern: '^Request rate limit exceeded\\.', flags: 'i' },
      { mode: 'regex', pattern: 'BUSY', flags: '' },
    ],
  });
  // 导出不应改动编辑器里的规则对象。
  assert.equal(rules[2].flags, undefined);
  assert.equal(internals.RULES_FILE_NAME, 'dsh-error-retry-rules.json');
});

test('导入接受 {rules:[...]} 与裸数组，空数组合法', () => {
  assert.deepEqual(plain(internals.parseRulesFile(JSON.stringify({ version: 1, rules: VALID_RULES }))), plain(VALID_RULES));
  assert.deepEqual(plain(internals.parseRulesFile(JSON.stringify(VALID_RULES))), plain(VALID_RULES));
  assert.deepEqual(plain(internals.parseRulesFile('{"rules":[]}')), []);
  assert.deepEqual(plain(internals.parseRulesFile('[]')), []);
});

test('非法正则、非法 flags 与空白规则被拒绝', () => {
  for (const rules of [
    [{ mode: 'regex', pattern: '(' }],
    [{ mode: 'regex', pattern: 'x', flags: 'g' }],
    [{ mode: 'regex', pattern: 'x', flags: 'y' }],
    [{ mode: 'regex', pattern: 'x', flags: 'ii' }],
    [{ mode: 'regex', pattern: 'x', flags: 'I' }],
    [{ mode: 'contains', pattern: '   ' }],
    [{ mode: 'contains', pattern: '' }],
    [{ mode: 'contains', pattern: 'x', flags: 'i' }],
  ]) {
    assert.throws(() => internals.parseRulesFile(JSON.stringify({ rules })), undefined, JSON.stringify(rules));
    assert.throws(() => internals.parseRulesFile(JSON.stringify(rules)), undefined, JSON.stringify(rules));
  }
});

test('非法 JSON、缺少 rules、错误条目与超大内容都给出错误', () => {
  for (const text of ['{not json', '{"version":1}', '"text"', 'null', '42', '']) {
    assert.throws(() => internals.parseRulesFile(text), undefined, text);
  }
  for (const entry of [
    null, 'x', 1, [], {},
    { mode: 'other', pattern: 'x' },
    { mode: 'contains' },
    { mode: 'contains', pattern: 1 },
    { mode: 'regex', pattern: 'x', flags: 1 },
  ]) {
    assert.throws(() => internals.parseRulesFile(JSON.stringify([entry])), undefined, JSON.stringify(entry));
  }
  assert.throws(() => internals.parseRulesFile('x'.repeat(internals.MAX_IMPORT_CHARS + 1)));
});

test('导入只生成草稿，不触发保存', () => {
  assert.deepEqual(plain(internals.importRulesIntoDraft(JSON.stringify({ rules: VALID_RULES }), 7)), {
    rules: VALID_RULES,
    revision: 7,
  });
  const start = source.indexOf('async function importFile');
  const end = source.indexOf('async function save', start);
  assert.ok(start >= 0 && end > start, '未找到导入处理函数');
  const handler = source.slice(start, end);
  assert.ok(handler.includes('setDraft(importRulesIntoDraft'));
  assert.ok(!handler.includes('mutate('), '导入不得直接写配置');
  // 保存是唯一调用 settings.mutate 的路径。
  assert.equal(source.split('form.mutate(').length - 1, 1);
});

test('导出与导入按钮使用浏览器下载和隐藏文件选择', () => {
  assert.ok(source.includes("accept: '.json,application/json'"));
  assert.ok(source.includes('link.download = RULES_FILE_NAME'));
  assert.ok(source.includes('URL.revokeObjectURL(url)'));
  assert.ok(!source.includes('body.appendChild'));
});
