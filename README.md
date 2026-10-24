# 规则重试 · Retry Rules

为 DeepSeek Harness 的模型请求提供可配置的错误重试。在插件详情页设置关键词、句子或正则表达式，任意规则命中后持续重试，直到成功、停止或取消。

**默认规则为空，不会主动接管任何错误。** 请只为确认适合重试的错误添加规则。

## 安装

从 npm 安装（把 `web` 换成你要安装的 profile 名称）：

```sh
dsh plugin --profile web add dsh-error-retry
```

也可以在 DSH 插件管理器里按包名 `dsh-error-retry` 安装，或从 Git 仓库安装：

```sh
dsh plugin --profile web add git+https://github.com/librola/dsh-error-retry.git
```

按插件管理器的安装结果刷新网页或重启 DSH；不要把源码更新等同于运行版本已更新。

## 在插件详情页配置

打开 **插件 → 已安装 → 规则重试**：

1. 点击“添加规则”。
2. 选择“包含关键词／句子”或“正则表达式”，填写匹配内容。
3. 正则可以设置 `i`、`m`、`s`、`u` 标志。
4. 点击“保存规则”。

包含匹配默认区分大小写；正则不要填写外围 `/.../`。例如：

```yaml
rules:
  - mode: contains
    pattern: 'Temporary service unavailable.'
  - mode: regex
    pattern: '^Request rate limit exceeded\.'
    flags: i
```

多条规则采用 OR 关系。清空列表后保存，将停止接管后续错误，但不改变 DSH 自带的其他重试策略。非法正则、空白内容或不支持的标志会被拒绝；其他页面修改配置时会提示冲突并保留草稿。

规则持久化到当前 profile。保存后的规则从**下一次错误判定**生效，不取消已经排定的等待；立即停止当前请求请使用会话的停止按钮。

## 导入与导出规则

详情页底部提供两个按钮：

- **导出规则**：把当前编辑中的规则（含未保存的草稿）下载为 `dsh-error-retry-rules.json`，内容形如：

  ```json
  {
    "version": 1,
    "rules": [
      { "mode": "contains", "pattern": "Temporary service unavailable." },
      { "mode": "regex", "pattern": "^Request rate limit exceeded\\.", "flags": "i" }
    ]
  }
  ```

- **导入规则**：选择 JSON 文件后，接受上面的对象格式，也接受直接给出规则数组的裸数组格式。导入会用与保存相同的规则校验：空内容、非法正则、非法 flags（`contains` 不允许 flags）都会被拒绝并显示具体原因；失败时不会改动现有草稿。

导入成功只写入**草稿**，不会自动保存；确认无误后仍需点击“保存规则”。导入同样遵循页面的配置冲突提示，其他页面改动过配置时不会静默覆盖。

规则文件只是本地 JSON，不包含凭据或机器信息，可以安全地复制到另一台机器或另一份 profile 使用。

## 行为与范围

- 仅匹配 DSH Agent 模型请求的 `failure.message`，不按 HTTP 状态码泛匹配。
- 作用于当前 profile 的模型请求，包括使用同一 Host 的子代理；不接管外部脚本、工具内部 HTTP 请求或直接调用 `ctx.llm.stream()` 的辅助任务。
- 不匹配的错误交给现有处理器。内置重试策略可能先执行，再委托本插件。
- 本地指数退避约 1、2、4、8、16、30 秒，带抖动；有效的服务端等待时间优先。
- 正则匹配有 25ms 总执行预算，超时不视为命中。
- 重试记录使用 DSH 会话事件，不向模型发送额外“继续”消息，不重新执行已完成的工具。
- 已经结束的失败回合不会自动唤醒，需要手动继续。

**无限重试可能产生持续请求和费用。** 永久错误或过宽的规则不一定能靠等待恢复。请避免无差别的 `.*`，必要时停止会话、修正请求，或禁用插件。

## 开发与测试

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm test
```

如需执行与已安装 DSH 的集成测试，将 `DSH_TEST_PACKAGE` 设置为该安装的 `package.json` 绝对路径：

```sh
DSH_TEST_PACKAGE="<DSH 安装目录>/package.json" npm test
```

未设置该变量时会跳过 DSH 集成测试。测试使用模拟请求，不调用付费模型；覆盖空默认规则、包含和正则匹配、持续重试、停止与卸载、配置保存冲突及浏览器配置序列化。

兼容 DSH `>=0.2.0-rc.2 <0.3.0-0`，声明在包清单的 `engines.dsh`；不逐版本列举精确版本，避免新版本被误判为不兼容。升级 DSH 后仍应重新验证接口和前端。配置入口、提示和图标提供中文与英文显示。SVG 图标为本项目原创。
