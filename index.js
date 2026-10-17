import { randomUUID } from 'node:crypto';
import { Script, createContext } from 'node:vm';
import { z } from 'zod';
import Schema from '@deepseek-ai/schemastery';

export const name = 'error-retry';
export const inject = ['sessionProjections'];
// 默认不接管错误，用户明确配置规则后才启用无限重试。
export const DEFAULT_RULES = Object.freeze([]);
// Settings 会先还原 schema 再序列化一次；还原后的回调也必须保留 toJSON，
// 否则 JSON 传输会丢弃 callback，浏览器校验失败并停留在 loading。
function restoreRuleValidator() {
  const validate = rules => {
    for (const [index, rule] of rules.entries()) {
      if (!/\S/.test(rule.pattern)) throw new Error(`规则 ${index + 1}：pattern 不能为空`);
      if (rule.mode === 'contains' && rule.flags !== undefined) throw new Error(`规则 ${index + 1}：contains 不接受 flags`);
      if (rule.mode === 'regex') {
        if (!/^[imsu]*$/.test(rule.flags ?? '')) throw new Error(`规则 ${index + 1}：flags 仅支持 i/m/s/u`);
        try { new RegExp(rule.pattern, rule.flags); }
        catch (error) { throw new Error(`规则 ${index + 1}：${error.message}`); }
      }
    }
    return rules;
  };
  // 工厂源码自包含，任意次 schema 往返都恢复相同的校验与序列化行为。
  validate.toJSON = () => `(${restoreRuleValidator.toString()})()`;
  return validate;
}
export const Config = Schema.object({
  rules: Schema.transform(Schema.array(Schema.object({
    mode: Schema.union(['contains', 'regex']).required(),
    pattern: Schema.string().required(),
    flags: Schema.string(),
  })), restoreRuleValidator(), true)
    .default([...DEFAULT_RULES]).volatile(),
});
const KEY = 'localErrorRetry';
const POLICY_PREFIX = JSON.stringify([name, 2]).slice(0, -1) + ',';
const MATCH_TIMEOUT_MS = 25;
const matchScript = new Script(`rules.some(rule => rule.mode === 'contains'
  ? message.includes(rule.pattern)
  : new RegExp(rule.pattern, rule.flags).test(message))`);

function normalizeRules(rules) {
  // OR 规则的顺序和重复项不改变语义；保留 pattern 的有效空白，不擅自 trim。
  const serialized = rules.map(rule => JSON.stringify(rule.mode === 'contains'
    ? { mode: rule.mode, pattern: rule.pattern }
    : { mode: rule.mode, pattern: rule.pattern, flags: new RegExp(rule.pattern, rule.flags).flags }));
  return [...new Set(serialized)].sort().map(value => JSON.parse(value));
}

export function retryDelay(retry, providerDelay, random = Math.random) {
  // 服务端要求的等待不截短；长等待在下方分段，避免 Node 定时器溢出。
  if (Number.isFinite(providerDelay) && providerDelay > 0) return providerDelay;
  const base = Math.min(1000 * 2 ** Math.min(retry - 1, 5), 30000);
  return Math.min(30000, Math.round(base * (0.9 + random() * 0.2)));
}

export async function waitForRetry(delayMs, signal) {
  let remaining = delayMs;
  while (remaining > 0) {
    if (signal.aborted) return false;
    const slice = Math.min(remaining, 2147483647);
    const completed = await new Promise(resolve => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve(true);
      }, slice);
      function abort() {
        clearTimeout(timer);
        resolve(false);
      }
      signal.addEventListener('abort', abort, { once: true });
    });
    if (!completed) return false;
    remaining -= slice;
  }
  return !signal.aborted;
}

export function apply(ctx, config) {
  const parsed = config?.rules?.get ? config : Config(config);
  // 每次失败读取最新规则，保存不会重挂插件，也不会取消已经开始的等待。
  let lastRules;
  let rules;
  let policyKey;
  function currentRules() {
    const value = parsed.rules.get();
    if (value !== lastRules) {
      rules = normalizeRules(value);
      policyKey = JSON.stringify([name, 2, rules]);
      lastRules = value;
    }
  }
  currentRules();
  ctx.sessionProjections.register({
    key: KEY,
    stateVersion: 2,
    stateSchema: z.record(z.string(), z.object({
      retry: z.number(), retryId: z.string(), policyKey: z.string(),
    })),
    init: () => ({}),
    apply(state, event) {
      // 真正进入新步骤时重置；同一步失败后的重试次数从持久日志恢复。
      if (event.type === 'step/start' || event.type === 'turn/end') return {};
      // 投影不捕获当前配置，避免缓存恢复时把旧规则的计数当成新规则。
      if (event.type !== 'llm/retry' || !event.data.policyKey.startsWith(POLICY_PREFIX)) return state;
      return { ...state, [JSON.stringify(event.data.provider)]: {
        retry: event.data.retry, retryId: event.data.retryId, policyKey: event.data.policyKey,
      } };
    },
  });
  const lifetime = new AbortController();
  const active = new Set();

  async function recover({ agent, turn, step, provider, failure, signal }, next) {
    if (signal.aborted || lifetime.signal.aborted) return;
    currentRules();
    if (rules.length === 0) return next();
    let matches;
    try {
      // pattern 始终作为数据传入；整组匹配共用超时，恶意回溯不能无限阻塞停止按钮。
      matches = matchScript.runInContext(createContext({ rules, message: failure.message }), {
        timeout: MATCH_TIMEOUT_MS,
      });
    } catch (error) {
      ctx.logger.warn(`error-retry: 规则匹配失败，本插件不接管重试（${error.code ?? error.name}）`);
      return next();
    }
    if (!matches) return next();
    const fused = AbortSignal.any([signal, lifetime.signal]);
    const state = ctx.sessionProjections.stateOf(agent.session, KEY);
    const candidate = state?.[JSON.stringify(provider)];
    const previous = candidate?.policyKey === policyKey ? candidate : undefined;
    const retry = (previous?.retry ?? 0) + 1;
    const retryId = previous?.retryId ?? randomUUID();
    const delayMs = retryDelay(retry, failure.providerRetryAfterMs);
    // 使用 DSH 现有非消息事件，既可审计，也不会向模型插入提示或重放工具。
    agent.session.append('llm/retry', {
      retryId, turn, step, provider, mode: 'always', policyKey,
      retry, delayMs, failure,
    });
    if (!await waitForRetry(delayMs, fused)) return;
    agent.session.append('llm/retry-started', { retryId, turn, step, retry });
    return { kind: 'retry' };
  }

  const disposeListener = ctx.on('agent/request-error', (payload, next) => {
    if (lifetime.signal.aborted) return Promise.resolve(undefined);
    const operation = recover(payload, next).finally(() => active.delete(operation));
    active.add(operation);
    return operation;
  });
  ctx.effect(() => async () => {
    disposeListener();
    lifetime.abort();
    await Promise.allSettled([...active]);
  });
}
