import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import Schema from '@deepseek-ai/schemastery';
import { Config, DEFAULT_RULES } from '../index.js';

const roundtrip = value => JSON.parse(JSON.stringify(value));

// 执行实际浏览器 bundle，只在测试末尾暴露非导出类；不复制或简化 schema 实现。
function browserSettings(require) {
  const filename = require.resolve('@deepseek-ai/dsh-client-ui-settings/client');
  let source = readFileSync(filename, 'utf8');
  const marker = 'exports.apply = apply;';
  assert.ok(source.includes(marker));
  source = source.replace(marker, `${marker}\nexports.testInternals = { SettingsSchemaService, ConfigFormController };`);
  let module;
  runInNewContext(source, { window: { __ModuleLoader__: { load(value) { module = value; } } } });
  const result = module.factory(id => {
    if (id === '@deepseek-ai/cordis') return { Service: class {} };
    if (id === '@deepseek-ai/dsh-client-store') return {};
    throw new Error(`未声明的浏览器测试依赖：${id}`);
  });
  return result.testInternals;
}

async function descriptor(require, schema, config = {}) {
  const { SettingsForms } = await import(require.resolve('@deepseek-ai/dsh-settings'));
  const entry = { id: 'include:error-retry', options: { id: 'error-retry', config },
    fiber: { uid: 1, state: 2, runtime: { Config: schema }, config: schema(config), ctx: {} } };
  const settings = Object.create(SettingsForms.prototype);
  Object.assign(settings, { presentations: new Map(), revisions: new Map(), ownerContext: {
    emit() {}, configEditor: { configuration: () => [{ entry, inherited: {}, override: {} }] },
  } });
  return roundtrip(settings.describe({ redactSecrets: true })[0]);
}

function controllerFrom(ConfigFormController, schemaService) {
  const controller = Object.create(ConfigFormController.prototype);
  let state = { status: 'loading', value: undefined };
  Object.assign(controller, { spec: { namespace: 'error-retry' }, schema: schemaService,
    store: { getSnapshot: () => state, update(fn) { const next = { ...state }; fn(next); state = next; } },
  });
  return controller;
}

test('真实Host投影经JSON传输后在真实浏览器schema校验并从loading进入ready', { skip: !process.env.DSH_TEST_PACKAGE }, async () => {
  const require = createRequire(process.env.DSH_TEST_PACKAGE);
  const { SettingsSchemaService, ConfigFormController } = browserSettings(require);
  const schemaService = new SettingsSchemaService({});
  // 旧写法只在初始函数上有toJSON：Host plainSchema还原后丢失，第二次JSON遗漏callback。
  const old = Schema.object({ rules: Schema.transform(Schema.array(Schema.any()), rules => rules, true)
    .default([...DEFAULT_RULES]).volatile() });
  const broken = await descriptor(require, old);
  assert.match(schemaService.validate(schemaService.rehydrate(broken.schema), broken.value), /callback/);
  const controller = controllerFrom(ConfigFormController, schemaService);
  controller.mirror = { getSnapshot: () => ({ view: { writable: true, namespaces: [broken] } }) };
  controller.derive();
  assert.equal(controller.getSnapshot().status, 'loading');

  const fixed = await descriptor(require, Config);
  assert.equal(schemaService.validate(schemaService.rehydrate(fixed.schema), fixed.value), undefined);
  controller.mirror = { getSnapshot: () => ({ view: { writable: true, namespaces: [fixed] } }) };
  controller.derive();
  assert.equal(controller.getSnapshot().status, 'ready');
  assert.deepEqual(controller.getSnapshot().value.rules, []);
  const explicitRules = [
    { mode: 'contains', pattern: 'Temporary service unavailable.' },
    { mode: 'regex', pattern: '^Request rate limit exceeded\\.', flags: 'i' },
  ];
  const configured = await descriptor(require, Config, { rules: explicitRules });
  controller.mirror = { getSnapshot: () => ({ view: { writable: true, namespaces: [configured] } }) };
  controller.derive();
  assert.equal(controller.getSnapshot().status, 'ready');
  assert.deepEqual(controller.getSnapshot().value.rules, explicitRules);
  for (let i = 0; i < 3; i++) {
    fixed.schema = roundtrip(schemaService.rehydrate(fixed.schema).toJSON());
    const restored = schemaService.rehydrate(fixed.schema);
    assert.equal(schemaService.validate(restored, { rules: [] }), undefined);
    assert.equal(schemaService.validate(restored, { rules: [{ mode: 'regex', pattern: '^busy$', flags: 'i' }] }), undefined);
    for (const rule of [{ mode: 'regex', pattern: '(' }, { mode: 'regex', pattern: 'x', flags: 'ii' },
      { mode: 'contains', pattern: '  ' }, { mode: 'contains', pattern: 'x', flags: 'i' }]) {
      assert.equal(typeof schemaService.validate(restored, { rules: [rule] }), 'string');
    }
  }
});

test('加载中不把尚未取得的配置误报为空规则', () => {
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  assert.ok(client.includes("state.status === 'ready' && rules.length === 0"));
});
