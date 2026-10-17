window.__ModuleLoader__.load({
  id: '@local/dsh-error-retry',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'localErrorRetry';
    const dictionaries = {
      zh: {
        title: '重试匹配规则', help: '任意一条命中即无限重试。关键词和句子用“包含”，复杂条件用正则。空列表表示本插件不接管错误。',
        risk: '宽泛规则或永久错误可能产生持续请求和费用。保存仅影响下一次错误判定；已经排定的等待仍会完成一次重试，可点击会话停止按钮取消。',
        add: '添加规则', remove: '删除规则', mode: '匹配方式', contains: '包含关键词／句子', regex: '正则表达式', pattern: '关键词、句子或正则', flags: '正则标志（i/m/s/u）',
        save: '保存规则', saving: '保存中…', saved: '已保存，下一次错误判定使用新规则。', discard: '放弃修改并读取最新配置',
        unavailable: '配置尚未就绪。请确认插件已启用并已重启加载新版。', loading: '读取配置中…', readonly: '当前配置只读。',
        conflict: '配置已被其他页面修改，未覆盖远端。草稿已保留，请放弃草稿读取最新配置后重新编辑。',
        rejected: '保存被拒绝，草稿已保留。请检查规则或重新读取最新配置。', invalid: '规则无效：', empty: '尚无规则，本插件不会接管任何错误。',
      },
      en: {
        title: 'Retry matching rules', help: 'Any matching rule retries indefinitely. Use contains for keywords or sentences, regex for patterns. An empty list handles no errors.',
        risk: 'Broad rules or permanent failures may produce ongoing requests and costs. Saving affects the next error decision; an already scheduled wait still completes one retry. Use the session Stop button to cancel.',
        add: 'Add rule', remove: 'Remove rule', mode: 'Match mode', contains: 'Contains keyword / sentence', regex: 'Regular expression', pattern: 'Keyword, sentence or pattern', flags: 'Regex flags (i/m/s/u)',
        save: 'Save rules', saving: 'Saving…', saved: 'Saved. New rules apply to the next error decision.', discard: 'Discard edits and load latest values',
        unavailable: 'Configuration is unavailable. Enable the plugin and restart to load the new version.', loading: 'Loading configuration…', readonly: 'Configuration is read-only.',
        conflict: 'Another page changed this configuration. Remote values were not overwritten and your draft was kept. Discard it and edit the latest values.',
        rejected: 'Save was rejected; your draft was kept. Check rules or reload the latest values.', invalid: 'Invalid rule: ', empty: 'No rules; this plugin will not handle any errors.',
      },
    };
    function validate(rules) {
      for (const [index, rule] of rules.entries()) {
        if (!/\S/.test(rule.pattern)) throw new Error(`#${index + 1}: pattern`);
        if (rule.mode === 'regex') {
          if (!/^[imsu]*$/.test(rule.flags ?? '')) throw new Error(`#${index + 1}: flags`);
          try { new RegExp(rule.pattern, rule.flags); }
          catch (error) { throw new Error(`#${index + 1}: ${error.message}`); }
        }
      }
      return rules.map(rule => rule.mode === 'contains'
        ? { mode: rule.mode, pattern: rule.pattern }
        : { mode: rule.mode, pattern: rule.pattern, flags: rule.flags ?? '' });
    }
    const css = `
.error-retry-config{display:grid;gap:14px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.error-retry-config h3,.error-retry-config p{margin:0}.error-retry-config h3{font-size:14px;font-weight:600}
.error-retry-config .error-retry-hint{color:var(--dsw-alias-label-secondary);font-size:12px}
.error-retry-config fieldset{margin:0;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;display:grid;gap:10px;min-width:0}
.error-retry-config label{display:grid;gap:5px}.error-retry-config textarea,.error-retry-config select,.error-retry-config input{box-sizing:border-box;width:100%;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:8px}
.error-retry-config textarea{resize:vertical;min-height:72px}.error-retry-config .error-retry-actions{display:flex;gap:8px;flex-wrap:wrap}
.error-retry-config button{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:7px 12px;cursor:pointer}
.error-retry-config button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}.error-retry-config button:disabled{opacity:.5;cursor:not-allowed}
.error-retry-config button:focus-visible,.error-retry-config input:focus-visible,.error-retry-config textarea:focus-visible,.error-retry-config select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.error-retry-config .error-retry-save{color:var(--dsw-alias-brand-primary)}.error-retry-config [role=alert]{color:var(--dsw-alias-label-primary);border-left:3px solid var(--dsw-alias-brand-primary);padding-left:10px}
`;
    function Editor({ form, t }) {
      const state = React.useSyncExternalStore(callback => form.subscribe(callback), () => form.getSnapshot());
      const [draft, setDraft] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      const [message, setMessage] = React.useState('');
      const [error, setError] = React.useState('');
      const mounted = React.useRef(true);
      React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
      const rules = draft?.rules ?? state.value?.rules ?? [];
      const conflict = draft !== null && draft.revision !== state.revision;
      const disabled = state.status !== 'ready' || !state.writable || saving;
      function change(next) {
        setDraft({ rules: next, revision: draft?.revision ?? state.revision });
        setError(''); setMessage('');
      }
      async function save(event) {
        event.preventDefault();
        if (disabled || !draft || conflict) return;
        let value;
        try { value = validate(draft.rules); }
        catch (cause) { setError(t('invalid') + cause.message); return; }
        setSaving(true); setError(''); setMessage('');
        try {
          const accepted = await form.mutate([{ op: 'set', path: ['rules'], value }], draft.revision);
          if (!mounted.current) return;
          if (accepted) { setDraft(null); setMessage(t('saved')); }
          else setError(t('rejected'));
        } catch (cause) {
          if (mounted.current) setError(t('rejected') + ' ' + cause.message);
        } finally { if (mounted.current) setSaving(false); }
      }
      return h('form', { className: 'error-retry-config', onSubmit: save },
        h('style', null, css), h('h3', null, t('title')),
        h('p', { className: 'error-retry-hint' }, t('help')), h('p', { className: 'error-retry-hint' }, t('risk')),
        state.status !== 'ready' ? h('p', { role: 'status' }, t(state.status === 'loading' ? 'loading' : 'unavailable')) : null,
        !state.writable && state.status === 'ready' ? h('p', null, t('readonly')) : null,
        state.status === 'ready' && rules.length === 0 ? h('p', { className: 'error-retry-hint' }, t('empty')) : null,
        rules.map((rule, index) => h('fieldset', { key: index, disabled },
          h('legend', null, `${index + 1}`),
          h('label', null, t('mode'), h('select', { value: rule.mode, onChange: event => change(rules.map((r, i) => i !== index ? r : event.target.value === 'contains' ? { mode: 'contains', pattern: r.pattern } : { ...r, mode: 'regex', flags: '' })) },
            h('option', { value: 'contains' }, t('contains')), h('option', { value: 'regex' }, t('regex')))),
          h('label', null, t('pattern'), h('textarea', { value: rule.pattern, spellCheck: false, onChange: event => change(rules.map((r, i) => i === index ? { ...r, pattern: event.target.value } : r)) })),
          rule.mode === 'regex' ? h('label', null, t('flags'), h('input', { value: rule.flags ?? '', spellCheck: false, onChange: event => change(rules.map((r, i) => i === index ? { ...r, flags: event.target.value } : r)) })) : null,
          h('div', { className: 'error-retry-actions' }, h('button', { type: 'button', onClick: () => change(rules.filter((_, i) => i !== index)) }, t('remove'))))),
        conflict ? h('p', { role: 'alert' }, t('conflict')) : null,
        error ? h('p', { role: 'alert' }, error) : null,
        message ? h('p', { role: 'status' }, message) : null,
        h('div', { className: 'error-retry-actions' },
          h('button', { type: 'button', disabled, onClick: () => change([...rules, { mode: 'contains', pattern: '' }]) }, t('add')),
          h('button', { type: 'submit', className: 'error-retry-save', disabled: disabled || !draft || conflict }, t(saving ? 'saving' : 'save')),
          draft ? h('button', { type: 'button', disabled: saving, onClick: () => { setDraft(null); setError(''); setMessage(''); } }, t('discard')) : null));
    }
    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dictionaries));
        const form = ctx.configForms.get('error-retry');
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: '@local/dsh-error-retry', locale: NS,
        }, props => h(Editor, { form, t: props.t })));
      },
    };
  },
});
