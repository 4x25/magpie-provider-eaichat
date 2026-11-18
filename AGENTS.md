# AGENTS.md

magpie 插件：云智助手（eaichat.ctyun.cn）Token 中心接入 magpie。TypeScript + ESM，无构建步骤，零运行时依赖（只用 `node:crypto` 和全局 `fetch`）。

面向用户的安装说明统一使用 `magpie plugin add github:4x25/magpie-provider-eaichat`。

## 命令

```sh
npm test          # 单元测试（node --test --experimental-strip-types，不联网）
npm run check     # tsc --noEmit
npm run update:models   # 从 models.dev 重新生成 src/model-metadata.ts
```

单个测试文件：`node --test --experimental-strip-types --no-warnings tests/state.test.ts`。

改动后两样都要过；提交前先 `check` 再 `test`。

## 语言/运行时约束（容易踩坑）

- 相对导入必须带 `.ts` 扩展名（`allowImportingTsExtensions` + `rewriteRelativeImportExtensions: false` + `verbatimModuleSyntax`）。
- 测试跑在 Node 的 strip-only 模式：**不支持 TS 参数属性**（`constructor(private x: X)` 会直接 SyntaxError）——显式声明字段再赋值。Bun 无此限制，但代码要两边都能跑：magpie 宿主用 Bun 直接加载 `src/index.ts`（`package.json` 的 `main`），测试用 Node。
- 类型导入用 `import type`（verbatimModuleSyntax 强制）。

## 结构与关键事实

- `src/index.ts` 是唯一入口（插件函数 `EAIChatPlugin(input, options)`，返回 config/provider/auth 钩子）。不要从入口导出辅助函数，测试需要的东西放 `_internal`。
- `src/state.ts` 是会话核心：按 `userHash` 分账号，同一账号并发登录/Key 解析合并为一次（single-flight）；`withSessionRetry` 在 sessionExpired 时强制重登并重试一次。
- `tests/helpers.ts` 的假上游实现了完整登录链路（真 RSA keypair、AES-ECB sessionKey、Web-Signature 验签），测试不 mock crypto 模块。验签必须用请求自带的 `web-random`/`web-timestamp`，不能重新生成（生成值每次不同，永远对不上）。
- 插件选项有两条路：`auth.options` 声明的 GUI 开关经 `input.magpie.option(provider, key)` 读；CLI `magpie plugin options` 写的进 plugins.json 作为插件函数第二参数。`wireProtocol()` 两者都认。
- `src/model-metadata.ts` 是**生成文件**，由 `scripts/update-model-metadata.ts` 从 models.dev 生成，不要手改。上游模型 ID 与 models.dev 规范 ID 的映射在 `src/constants.ts` 的 `MODEL_IDS`；换模型只改映射，再跑 `npm run update:models`。
- 默认协议是 OpenAI（`use_openai` 默认 true）：思考档位经 `X-Magpie-Effort` 到达 `relayFetch`，OpenAI 端点写 `enable_thinking` + `reasoning_effort`，Anthropic 端点写 `thinking.budget_tokens` + `output_config.effort`。没有该头时请求体保持原样。

## 上游实测行为（2026-11-12 验证，写代码前先信这里）

- **两个模型端点都只认 `Authorization: Bearer <apiKey>`**。Anthropic 端点对 `x-api-key` 返回 401——`src/relay.ts` 统一改写认证头，别去掉这层。
- 思考档位（2026-11-18 实测）：OpenAI 端点接受 `reasoning_effort` 的 `none/minimal/low/medium/high/xhigh/max/ultra`，非法值返回 400 并列出枚举；`enable_thinking: false` 可关掉 DeepSeek/Qwen 的思考，但 GLM 会忽略，所以 GLM 的档位没有 `none`。Anthropic 端点接受 `thinking.budget_tokens` 和 `output_config.effort`。
- Anthropic 路径带 `/v1`：`/ai/platform/v2/cp/anthropic/v1/messages`；OpenAI 是 `/ai/platform/v2/cp/chat/completions`。
- 用量接口上游拼写就是 `usage/summry`（不是 summary）。
- API Key 列表（`platform/cp/apiKeys`）会回显完整密钥（`apiKey` 字段）；`addApiKey` 响应字段名未实测，代码做了多候选兼容。
- 每日签到任务 `taskDefId=3001`，领取接口是 `receivePointsV2`，`progress` 传任务当前的 `currentProgress`。
- 出网 DNS 经常抖动（getaddrinfo ETIMEOUT），实机脚本和登录路径都有重试；偶发失败先重试再排查。
- 登录链路没有 refresh token：续登 = 用密码摘要重走完整 IAM→CAS→ticketAuthorize。IAM 要的密码就是 SHA-256 摘要，因此持久化的摘要即凭据。

## 凭据与安全（硬性要求）

- `.env`（`EAICHAT_USERNAME` / `EAICHAT_PASSWORD`）不入库、不打印、不进上下文。测试账号额度有限，实机验证要省着用：模型调用用小 `max_tokens`，能用复用/探测代替的就别对话。
- 账号显示用 `maskAccount` 脱敏；密钥只显示末 4 位。
- `client.auth.set` 是**整对象替换**：运行期写回必须带完整形状（`type`/`refresh`/`access`/`expires`/`user`/`userHash`/`accountId`/`apiKey`），漏字段会把宿主保存的 `access` 抹掉。`refresh` 字段承载密码摘要，`asStoredAuth` 也能从 `refresh` 兜底还原 `pwHash`。

## 实机验证（magpie 沙箱）

```sh
sb=$(mktemp -d /tmp/opencode/magpie-eai-XXXX)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add .            # 本仓库当前内容，关掉再开即重载
m plugin --json           # 钩子/模型/选项是否如预期
m provider test eaichat glm-5.3-flash   # 网关全链路（慢，真实调用）
m quota eaichat           # usage 钩子
m accounts checkin        # checkin 钩子（一次手动触发）
```

- 实机联调优先用 `node --experimental-strip-types --no-warnings scripts/live-check.ts`（读 `.env`、带重试、不打印凭据；`--no-chat` 跳过模型调用省 token）。
- 本机装的 magpie 是 0.1.1331（2026-10 构建）：providers 清单里不显示 `renews`、不读 `refreshLead`（默认提前 5 分钟），但 `auth.refresh` 钩子会被正常调用。
- 协议开关切换后，模型的 `npm` 要等列表刷新（`m plugin --json` 重跑）才变；缓存的 `plugin-providers.json` 会短暂显示旧协议。
- 每日自动签到默认关：需在 magpie 设置里为本供应商开启，插件侧只提供 `auth.checkin`。
