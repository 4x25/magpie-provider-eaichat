# magpie-provider-eaichat

把 [云智助手](https://eaichat.ctyun.cn)（天翼云）的 Token 中心接入 [magpie](https://usemagpie.ai)：作为大模型供应商使用，并提供自动每日签到和用量显示。

## 功能

- **模型转发**：6 个模型（`deepseek-v4.1-flash`、`glm-5.3-flash`、`deepseek-v4-flash-0731-oc`、`deepseek-v4-pro-0813-oc`、`glm-5.3-oc`、`qwen-3.8-flash`），默认走 Anthropic Messages 端点，可在插件选项中切换为 OpenAI Chat Completions 端点（从下一个请求起生效）。
- **登录**：账号 + 密码（IAM → CAS → ticketAuthorize 链路），API Key 可选。
- **自动续登**：JWT 到期前 6 小时自动重走登录链路；网页会话中途失效时自动重登并重试一次。
- **每日签到**：通过 magpie 自带的签到调度（每个北京日一次），领取 `taskDefId=3001` 的「每日签到」Token 奖励。
- **用量显示**：读取 Token 中心的 `platform/cp/usage/summry`，在账号额度卡片 / `magpie quota` / `GET /v1/magpie/quotas` 中显示已用、剩余、已过期额度。

## 登录交互

1. 必填：云智助手账号（手机号或邮箱）
2. 必填：密码
3. 可选：API Key

未填 API Key 时，自动查找账号名下名为 `magpie-provider-eaichat` 的 Key；不存在则自动创建一个。密钥只保存在 magpie 的 `plugin-auth.json`（权限 600），密码以 SHA-256 摘要保存（登录链路上游要求的就是该摘要），不会写入日志或仓库。

## 安装

```sh
magpie plugin add ./magpie-provider-eaichat
# 或发布到 npm 后：magpie plugin add magpie-provider-eaichat
magpie plugin login eaichat
```

## 每日签到

插件实现了 magpie 的 `auth.checkin`。要每个北京日自动签到，需在 magpie 的 **设置 → 签到** 里为本供应商开启每日签到（默认关闭）；`magpie accounts checkin` 可随时手动触发一次。签到结果（获得多少 Token、连续天数）显示在账号的用量卡片上。

## 用量口径

额度窗口以「已用 + 剩余」为分母：剩余归零即 100%，与 magpie 的路由判断一致；已过期（`expTokens`）额度不参与比例，单独显示。数字保留上游精度。

## 实测记录（2026-11-12，magpie 0.1.1331）

- 登录链路（IAM → CAS → ticketAuthorize）、API Key 列表回显、用量读取、每日签到状态读取：全部通过。
- 两个模型端点均只认 `Authorization: Bearer <apiKey>`（Anthropic 端点对 `x-api-key` 返回 401），插件已在转发层统一改写认证头。
- Anthropic Messages（流式/非流式）与 OpenAI Chat Completions 均通过 magpie 网关全链路验证（`magpie provider test`）。
- 到期前的 `auth.refresh` 自动续登：触发后重登并把 `expires` 刷新为 +7 天，`access`/`refresh`/`apiKey` 完整写回。

## 开发

```sh
npm install
npm test        # 单元测试（模拟上游，不联网）
npm run check   # tsc --noEmit
node --experimental-strip-types --no-warnings scripts/live-check.ts   # 实机验证（读 .env，不打印凭据）
```

### 结构

```
src/
  index.ts     插件入口（config/provider/auth 钩子）
  eaichat.ts   云智助手客户端（登录链路、签名、portal 接口）
  state.ts     账号会话管理（续登、Key 解析、并发合并）
  models.ts    模型目录（6 个模型 × 两种协议）
  usage.ts     用量映射
  checkin.ts   签到映射
  relay.ts     模型请求转发（URL 归一 + 透传）
  crypto.ts    加密/签名原语
  http.ts      CookieJar 等基础设施
  constants.ts 常量
tests/         node --test 单元测试（含完整登录链路的假上游）
```

### 已知待校准项

- 模型上下文/输出上限按各家族公版保守取值（128K / 8K）；上游 `/platform/cp/models` 未提供限额数值，如实际不符再调整。
- `addApiKey` 的创建路径未在真实账号实测（该账号已有同名 Key，走了复用路径）；响应字段名做了多候选兼容（`apiKey`/`key`/`keySecret` 等），列表回显字段已实测为 `apiKey`。

## License

MIT
