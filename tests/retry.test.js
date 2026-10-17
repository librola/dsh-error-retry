import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { apply, Config, DEFAULT_RULES, retryDelay, waitForRetry } from '../index.js';

const MESSAGE = 'Temporary service unavailable.';
const RATE_MESSAGE = 'Request rate limit exceeded.';
const TEST_RULES = [MESSAGE, RATE_MESSAGE].map(pattern => ({ mode: 'contains', pattern }));

function harness() {
  const units = new Map();
  const states = new Map();
  const listeners = [];
  const cleanups = [];
  const events = [];
  const ctx = {
    logger: { warn() {} },
    sessionProjections: {
      register(unit) { units.set(unit.key, unit); states.set(unit.key, unit.init()); },
      stateOf(session, key) { return states.get(key); },
    },
    on(event, listener) {
      assert.equal(event, 'agent/request-error');
      listeners.push(listener);
      return () => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1); };
    },
    effect(factory) { cleanups.push(factory()); },
  };
  const session = { append(type, data) {
    const event = { type, data };
    events.push(event);
    for (const [key, unit] of units) {
      states.set(key, unit.stateSchema.parse(unit.apply(states.get(key), event)));
    }
  } };
  const controller = new AbortController();
  const payload = { agent: { session }, turn: 1, step: 1, provider: 'test',
    signal: controller.signal, failure: { message: MESSAGE, code: 'RATE_LIMIT', providerRetryAfterMs: 1 },
    retryPolicy: { mode: 'normal', maxRetries: 5, retryableCodes: ['RATE_LIMIT'], initialDelayMs: 1, maxDelayMs: 10, jitterRatio: 0 },
  };
  const run = (next = async () => undefined) => {
    const call = i => listeners[i] ? listeners[i](payload, () => call(i + 1)) : next();
    return call(0);
  };
  return { ctx, events, session, controller, payload, run, units, states,
    dispose: () => Promise.all(cleanups.map(fn => fn())) };
}

test('Config 默认空列表、结构可投影，非法配置在注册任何资源前失败', () => {
  assert.deepEqual(Config(undefined).rules.get(), DEFAULT_RULES);
  assert.deepEqual(Config({}).rules.get(), DEFAULT_RULES);
  assert.equal(Config.dict.rules.meta.volatile, true);
  assert.equal(Config.dict.rules.inner.type, 'array');
  for (const rules of [
    [{ mode: 'contains', pattern: '' }], [{ mode: 'contains', pattern: ' \t\n' }],
    [{ mode: 'contains', pattern: 'x', flags: 'i' }], [{ mode: 'contains', pattern: 'x', flags: '' }],
    [{ mode: 'regex', pattern: '(' }], [{ mode: 'regex', pattern: 'x', flags: 'g' }],
    [{ mode: 'regex', pattern: 'x', flags: 'y' }], [{ mode: 'regex', pattern: 'x', flags: 'ii' }],
    [{ mode: 'regex', pattern: 'x', flags: 'd' }], [{ mode: 'regex', pattern: 'x', flags: 'v' }],
    [{ mode: 'regex', pattern: 'x', flags: 'I' }], [{ mode: 'other', pattern: 'x' }],
  ]) {
    const h = harness();
    assert.throws(() => Config({ rules }));
    assert.throws(() => apply(h.ctx, { rules }));
    assert.equal(h.units.size, 0);
  }
});

test('配置序列化后可独立校验且保留空数组', async () => {
  const { default: Schema } = await import('@deepseek-ai/schemastery');
  const restored = new Schema(JSON.parse(JSON.stringify(Config.toJSON())));
  assert.deepEqual(restored({ rules: [] }).rules.get(), []);
  assert.deepEqual(restored({ rules: [{ mode: 'regex', pattern: 'busy', flags: 'i' }] }).rules.get(),
    [{ mode: 'regex', pattern: 'busy', flags: 'i' }]);
  assert.throws(() => restored({ rules: [{ mode: 'regex', pattern: '(' }] }));
  assert.throws(() => restored({ rules: [{ mode: 'contains', pattern: '   ' }] }));
});

test('volatile保存不取消已排定重试，下次错误立即使用新规则', async () => {
  const { updateVolatile } = await import('@deepseek-ai/cosmokit');
  const parsed = Config({ rules: TEST_RULES });
  const h = harness(); apply(h.ctx, parsed);
  const pending = h.run();
  updateVolatile(parsed.rules, Config({ rules: [] }).rules);
  assert.deepEqual(await pending, { kind: 'retry' });
  assert.equal(await h.run(async () => 'next'), 'next');
  updateVolatile(parsed.rules, Config({ rules: [{ mode: 'contains', pattern: 'New error' }] }).rules);
  h.payload.failure.message = 'New error';
  assert.deepEqual(await h.run(), { kind: 'retry' });
  assert.equal(h.events.at(-2).data.retry, 1);
  await h.dispose();
});

test('显式配置第二条句子同样无限重试', async () => {
  const h = harness(); apply(h.ctx, { rules: TEST_RULES });
  h.payload.failure.message = `HTTP 400: ${RATE_MESSAGE}`;
  for (let i = 0; i < 7; i++) assert.deepEqual(await h.run(), { kind: 'retry' });
  await h.dispose();
});

test('自定义规则替换默认、OR匹配和contains默认大小写敏感', async () => {
  const h = harness(); apply(h.ctx, { rules: [
    { mode: 'contains', pattern: 'Overloaded' }, { mode: 'regex', pattern: '^busy$', flags: 'i' },
  ] });
  for (const text of ['server Overloaded now', 'BUSY']) {
    h.payload.failure.message = text;
    assert.deepEqual(await h.run(), { kind: 'retry' });
  }
  for (const text of [MESSAGE, RATE_MESSAGE, 'overloaded', 'not busy']) {
    h.payload.failure.message = text;
    assert.equal(await h.run(async () => 'next'), 'next');
  }
  await h.dispose();
});

test('默认配置不接管任何错误，显式规则才启用', async () => {
  assert.deepEqual(DEFAULT_RULES, []);
  for (const config of [undefined, {}]) {
    const h = harness(); apply(h.ctx, config);
    for (const message of [MESSAGE, RATE_MESSAGE, 'Other error']) {
      h.payload.failure.message = message;
      assert.equal(await h.run(async () => 'next'), 'next');
    }
    assert.equal(h.events.length, 0);
    await h.dispose();
  }
});

test('空列表不接管任何错误', async () => {
  const h = harness(); apply(h.ctx, { rules: [] });
  assert.equal(await h.run(async () => 'next'), 'next');
  assert.equal(h.events.length, 0);
  await h.dispose();
});

test('正则i/m/s/u可组合，多次匹配无lastIndex状态', async () => {
  const h = harness(); apply(h.ctx, { rules: [{ mode: 'regex', pattern: '^busy.*quota.$', flags: 'umsi' }] });
  h.payload.failure.message = 'header\nBUSY\nquota😀';
  for (let i = 0; i < 10; i++) assert.deepEqual(await h.run(), { kind: 'retry' });
  await h.dispose();
  const sensitive = harness(); apply(sensitive.ctx, { rules: [{ mode: 'regex', pattern: '^busy$' }] });
  sensitive.payload.failure.message = 'BUSY';
  assert.equal(await sensitive.run(), undefined);
  await sensitive.dispose();
});

test('ReDoS被VM超时中断，明确警告且不伪称匹配', async () => {
  const h = harness(); const warnings = [];
  h.ctx.logger.warn = message => warnings.push(message);
  apply(h.ctx, { rules: [{ mode: 'regex', pattern: '^(a+)+$' }] });
  h.payload.failure.message = 'a'.repeat(10000) + '!';
  assert.equal(await h.run(async () => 'next'), 'next');
  assert.equal(h.events.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ERR_SCRIPT_EXECUTION_TIMEOUT/);
  h.controller.abort();
  assert.equal(await h.run(), undefined);
  await h.dispose();
});

test('policyKey规范化规则顺序重复项和flags，并隔离旧配置缓存', async () => {
  const rules = [{ mode: 'contains', pattern: 'x' }, { mode: 'regex', pattern: 'x', flags: 'mi' }];
  const first = harness(); apply(first.ctx, { rules }); first.payload.failure.message = 'x';
  await first.run(); await first.run();
  const oldState = structuredClone(first.states.get('localErrorRetry'));
  const oldEvent = first.events[0];
  const same = harness(); apply(same.ctx, { rules: [
    { mode: 'regex', pattern: 'x', flags: 'im' }, rules[0], rules[0],
  ] });
  same.states.set('localErrorRetry', oldState); same.payload.failure.message = 'x';
  await same.run();
  assert.equal(same.events[0].data.policyKey, oldEvent.data.policyKey);
  assert.equal(same.events[0].data.retry, 3);
  const changed = harness(); apply(changed.ctx, { rules: [{ mode: 'contains', pattern: 'xx' }] });
  changed.states.set('localErrorRetry', oldState); changed.payload.failure.message = 'xx';
  await changed.run();
  assert.equal(changed.events[0].data.retry, 1);
  assert.notEqual(changed.events[0].data.retryId, oldEvent.data.retryId);
  assert.equal(changed.units.get('localErrorRetry').stateVersion, 2);
  const unit = changed.units.get('localErrorRetry');
  const empty = unit.init();
  assert.equal(unit.apply(empty, { type: 'llm/retry', data: {
    ...oldEvent.data, policyKey: JSON.stringify(['error-retry', 1, MESSAGE]),
  } }), empty);
  await first.dispose(); await same.dispose(); await changed.dispose();
});

test('完整原文和包装原文持续重试，超过常规预算后仍不停止', async () => {
  const h = harness(); apply(h.ctx, { rules: TEST_RULES });
  for (let i = 0; i < 101; i++) {
    h.payload.failure.message = i % 2 ? `429: {"error":{"message":"${MESSAGE}"}}` : MESSAGE;
    assert.deepEqual(await h.run(() => assert.fail('不得委托匹配错误')), { kind: 'retry' });
  }
  const retries = h.events.filter(e => e.type === 'llm/retry');
  assert.equal(retries.length, 101);
  assert.equal(retries.at(-1).data.retry, 101);
  assert.equal(new Set(retries.map(e => e.data.retryId)).size, 1);
  assert.equal(h.events.at(-1).type, 'llm/retry-started');
  h.session.append('step/start', { turn: 1, step: 2 });
  await h.run();
  assert.equal(h.events.at(-2).data.retry, 1);
  await h.dispose();
});

test('不匹配的限流、鉴权、近似文本保持下游决定', async () => {
  const h = harness(); apply(h.ctx, { rules: TEST_RULES });
  for (const message of ['Rate limit exceeded', 'Unauthorized', MESSAGE.toLowerCase(), MESSAGE.slice(0, -1)]) {
    h.payload.failure.message = message;
    assert.equal(await h.run(async () => 'downstream'), 'downstream');
  }
  assert.equal(h.events.length, 0);
  await h.dispose();
});

test('匹配不依赖HTTP状态、错误码或provider策略是否存在', async () => {
  const h = harness(); apply(h.ctx, { rules: TEST_RULES });
  h.payload.retryPolicy = undefined;
  h.payload.failure.code = 'UNKNOWN';
  h.payload.failure.status = 503;
  assert.deepEqual(await h.run(), { kind: 'retry' });
  await h.dispose();
});

test('先写调度日志，取消等待后不发出重试开始', async () => {
  const h = harness(); apply(h.ctx, { rules: TEST_RULES });
  h.payload.failure.providerRetryAfterMs = 60000;
  const pending = h.run();
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].data.delayMs, 60000);
  h.controller.abort();
  assert.equal(await pending, undefined);
  assert.equal(h.events.length, 1);
  await h.dispose();
});

test('卸载会取消等待，已捕获的回调也不会再重试', async () => {
  const h = harness();
  let savedListener;
  const on = h.ctx.on;
  h.ctx.on = (event, fn) => { savedListener = fn; return on(event, fn); };
  apply(h.ctx, { rules: TEST_RULES });
  h.payload.failure.providerRetryAfterMs = 60000;
  const pending = h.run();
  await h.dispose();
  assert.equal(await pending, undefined);
  assert.equal(await savedListener(h.payload, () => assert.fail()), undefined);
  assert.equal(h.events.length, 1);
});

test('已取消的回合不调度', async () => {
  const h = harness(); apply(h.ctx, { rules: TEST_RULES }); h.controller.abort();
  assert.equal(await h.run(), undefined);
  assert.equal(h.events.length, 0);
  await h.dispose();
});

test('指数退避、抖动和服务端等待边界', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 10000].map(i => retryDelay(i, undefined, () => 0.5)),
    [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(retryDelay(1, undefined, () => 0), 900);
  assert.equal(retryDelay(1, undefined, () => 1), 1100);
  for (const delay of [NaN, Infinity, -1, 0]) assert.equal(retryDelay(1, delay, () => 0.5), 1000);
  assert.equal(retryDelay(1, 60000), 60000);
});

test('超长服务端等待分段，不溢出成1毫秒重试', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = new AbortController();
  let settled = false;
  const waiting = waitForRetry(2147483647 + 5000, c.signal).then(v => { settled = true; return v; });
  t.mock.timers.tick(2147483647);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(4999);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  assert.equal(await waiting, true);
});

test('真实Settings投影、保存和revision冲突，不修改任何profile', { skip: !process.env.DSH_TEST_PACKAGE }, async () => {
  const require = createRequire(process.env.DSH_TEST_PACKAGE);
  const { SettingsForms } = await import(require.resolve('@deepseek-ai/dsh-settings'));
  const parsed = Config({});
  const entry = { id: 'include:error-retry', options: { id: 'error-retry', config: {} },
    fiber: { uid: 1, state: 2, runtime: { Config }, config: parsed, ctx: {} } };
  let writes = 0;
  const owner = { emit() {}, configEditor: {
    entries: () => [entry],
    configuration: () => [{ entry, inherited: {}, override: entry.options.config }],
    async edit(target, change) {
      const next = change(target.options.config, {});
      const value = Config(next);
      writes++;
      target.options.config = next;
      target.fiber.config = value;
    },
  } };
  const settings = Object.create(SettingsForms.prototype);
  Object.assign(settings, { ownerContext: owner, presentations: new Map(), revisions: new Map() });
  const first = settings.describe({ redactSecrets: true })[0];
  assert.equal(first.ns, 'error-retry');
  assert.deepEqual(first.value.rules, DEFAULT_RULES);
  assert.equal(first.applies, 'live');
  await settings.mutate(first.ns, [{ op: 'set', path: ['rules'], value: TEST_RULES }], first.revision);
  assert.deepEqual(settings.describe()[0].value.rules, TEST_RULES);
  await assert.rejects(settings.mutate(first.ns, [{ op: 'set', path: ['rules'], value: DEFAULT_RULES }], first.revision));
  const latest = settings.describe()[0];
  await assert.rejects(settings.mutate(first.ns, [{ op: 'set', path: ['rules'], value: [{ mode: 'regex', pattern: '(' }] }], latest.revision));
  assert.equal(writes, 1);
  assert.deepEqual(settings.describe()[0].value.rules, TEST_RULES);
  const regexRules = [{ mode: 'regex', pattern: '^Temporary service unavailable\\.', flags: 'i' }];
  await settings.mutate(first.ns, [{ op: 'set', path: ['rules'], value: regexRules }], latest.revision);
  assert.deepEqual(settings.describe()[0].value.rules, regexRules);
  const saved = settings.describe()[0];
  await settings.mutate(first.ns, [{ op: 'set', path: ['rules'], value: [] }], saved.revision);
  assert.deepEqual(settings.describe()[0].value.rules, []);
  assert.equal(writes, 3);
});

test('真实DSH Session接受重试事件且恢复后不污染模型消息', { skip: !process.env.DSH_TEST_PACKAGE }, async () => {
  const require = createRequire(process.env.DSH_TEST_PACKAGE);
  const { Session } = await import(require.resolve('@deepseek-ai/dsh-session'));
  const session = Session.create('error-retry-test');
  const h = harness(); apply(h.ctx, { rules: TEST_RULES });
  const append = h.session.append;
  h.session.append = (type, data) => { session.append(type, data); append(type, data); };
  await h.run();
  const events = session.snapshotEvents();
  assert.equal(events.length, 2);
  const restored = Session.create('error-retry-test', events, session.header);
  assert.deepEqual(restored.deriveMessages(), []);
  assert.equal(restored.snapshotEvents()[0].data.failure.message, MESSAGE);
  await h.dispose();
});

test('与当前安装的DSH内置重试器串联：5次后定向插件继续', { skip: !process.env.DSH_TEST_PACKAGE }, async () => {
  const require = createRequire(process.env.DSH_TEST_PACKAGE);
  const builtin = await import(require.resolve('@deepseek-ai/dsh-llm-retry'));
  const h = harness(); builtin.apply(h.ctx); apply(h.ctx, { rules: TEST_RULES });
  for (let i = 0; i < 12; i++) assert.deepEqual(await h.run(), { kind: 'retry' });
  const retries = h.events.filter(e => e.type === 'llm/retry');
  assert.equal(retries.filter(e => e.data.mode === 'normal').length, 5);
  assert.equal(retries.filter(e => e.data.mode === 'always').length, 7);
  h.payload.failure.message = 'Different rate limit';
  assert.equal(await h.run(), undefined);
  await h.dispose();
});
