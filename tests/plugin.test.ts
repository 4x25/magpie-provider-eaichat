import { strict as assert } from "node:assert"
import { test } from "node:test"
import EAIChatPlugin from "../src/index.ts"
import { sha256Hex } from "../src/crypto.ts"
import { dailyTask, fakeJwt, makeFakeUpstream, streakTask } from "./helpers.ts"
import { API_KEY_NAME, PROVIDER_ID } from "../src/constants.ts"

const USER = "13800000000@example.com"

/** 用假上游接管全局 fetch（插件内部的 EaiChatClient 用全局 fetch）。 */
async function withFake<T>(
  fn: (fake: ReturnType<typeof makeFakeUpstream>) => Promise<T>,
): Promise<T> {
  const fake = makeFakeUpstream()
  const original = globalThis.fetch
  globalThis.fetch = fake.fetchImpl as typeof fetch
  try {
    return await fn(fake)
  } finally {
    globalThis.fetch = original
  }
}

async function makePlugin(magpie?: { option?: (provider: string, key: string) => unknown }) {
  const saved: unknown[] = []
  const client = {
    auth: {
      set: async (args: { body: unknown }) => {
        saved.push(args.body)
        return { data: undefined }
      },
    },
    app: { log: async () => ({ data: undefined }) },
  }
  const hooks = await EAIChatPlugin({ client, magpie }, {})
  return { hooks, saved }
}

/** 走完登录（自动建 Key），返回宿主保存形状的 auth。 */
async function signInAs(
  hooks: Awaited<ReturnType<typeof makePlugin>>["hooks"],
): Promise<Record<string, string>> {
  const method = hooks.auth.methods[0]
  const started = method.authorize({ username: USER, password: "correct-password", apiKey: "" })
  assert.ok("callback" in started)
  const r = (await started.callback()) as Record<string, string>
  assert.equal(r.type, "success")
  return { ...r, type: "oauth" }
}

test("插件钩子结构：config/provider/auth 齐全", async () => {
  const { hooks } = await makePlugin()
  assert.equal(hooks.provider.id, PROVIDER_ID)
  assert.equal(hooks.auth.provider, PROVIDER_ID)
  assert.equal(typeof hooks.auth.loader, "function")
  assert.equal(typeof hooks.auth.usage, "function")
  assert.equal(typeof hooks.auth.refresh, "function")
  assert.equal(typeof hooks.auth.checkin, "function")
  assert.equal(hooks.auth.refreshLead, 6 * 60 * 60 * 1000)
  assert.equal(hooks.auth.options[0].key, "use_openai")
  assert.equal(hooks.auth.options[0].default, true)
})

test("登录方式：必填账号/密码 + 可选 API Key", async () => {
  const { hooks } = await makePlugin()
  const method = hooks.auth.methods[0]
  assert.equal(method.type, "oauth")
  assert.deepEqual(
    method.prompts.map((p: { key: string }) => p.key),
    ["username", "password", "apiKey"],
  )
  assert.equal(method.prompts[0].validate!(""), "账号不能为空")
  assert.equal(method.prompts[1].validate!(""), "密码不能为空")
  assert.equal(method.prompts[2].validate, undefined) // API Key 可选
})

test("config 钩子声明供应商，不声明模型（清单只来自上游）", async () => {
  const { hooks } = await makePlugin()
  const cfg: { provider?: Record<string, unknown> } = {}
  await hooks.config(cfg)
  const p = cfg.provider![PROVIDER_ID] as {
    name: string
    npm: string
    api: string
    models: Record<string, unknown>
  }
  assert.equal(p.name, "云智助手")
  assert.equal(p.npm, "@ai-sdk/openai-compatible")
  assert.equal(p.api, "https://eaichat.ctyun.cn/ai/platform/v2/cp")
  assert.deepEqual(p.models, {})
  // ??= 不覆盖用户已有配置
  const cfg2 = { provider: { [PROVIDER_ID]: { name: "自定义" } } }
  await hooks.config(cfg2)
  assert.equal((cfg2.provider[PROVIDER_ID] as { name: string }).name, "自定义")
})

test("authorize：登录 + 自动创建 API Key，返回可续登的 oauth 字段", async () => {
  await withFake(async (fake) => {
    const { hooks } = await makePlugin()
    const auth = await signInAs(hooks)
    assert.equal(auth.accountId, USER)
    assert.equal(auth.refresh, sha256Hex("correct-password"))
    assert.equal(auth.apiKey, "sk-eai-1")
    assert.ok(Number(auth.expires) > Date.now())
    assert.ok(auth.access.length > 20)
    assert.equal(fake.counters.addApiKey, 1)
  })
})

test("authorize：手填 API Key 时不创建", async () => {
  await withFake(async (fake) => {
    const { hooks } = await makePlugin()
    const method = hooks.auth.methods[0]
    const started = method.authorize({ username: USER, password: "correct-password", apiKey: "sk-manual" })
    assert.ok("callback" in started)
    const r = (await started.callback()) as Record<string, string>
    assert.equal(r.type, "success")
    assert.equal(r.apiKey, "sk-manual")
    assert.equal(fake.counters.addApiKey, 0)
  })
})

test("authorize：密码错误返回 failed", async () => {
  await withFake(async () => {
    const { hooks } = await makePlugin()
    const method = hooks.auth.methods[0]
    const started = method.authorize({ username: USER, password: "wrong", apiKey: "" })
    assert.ok("callback" in started)
    const r = (await started.callback()) as Record<string, string>
    assert.equal(r.type, "failed")
    assert.match(r.error as string, /账号或密码/)
  })
})

test("loader：返回 baseURL/apiKey/fetch（复用已有会话，不重复登录）", async () => {
  await withFake(async (fake) => {
    const { hooks } = await makePlugin()
    const auth = await signInAs(hooks)
    const logins = fake.counters.logins
    const loader = await hooks.auth.loader(async () => auth)
    assert.equal(loader.apiKey, "sk-eai-1")
    assert.equal(loader.baseURL, "https://eaichat.ctyun.cn/ai/platform/v2/cp")
    assert.equal(typeof loader.fetch, "function")
    // authorize 已收养会话：loader 不再登录
    assert.equal(fake.counters.logins, logins)
  })
})

test("usage：读出 Token 中心用量窗口", async () => {
  await withFake(async (fake) => {
    fake.state.usage = { totalTokens: 800_000, usedTokens: 1_000, expTokens: 0, remainTokens: 799_000 }
    const { hooks } = await makePlugin()
    const auth = await signInAs(hooks)
    const usage = (await hooks.auth.usage(async () => auth)) as {
      plan: string
      windows: Array<{ amount: number; limit: number; unit: string }>
    }
    assert.equal(usage.plan, "Token 中心")
    assert.equal(usage.windows[0].amount, 1_000)
    assert.equal(usage.windows[0].limit, 800_000)
    assert.equal(usage.windows[0].unit, "tokens")
  })
})

test("usage：会话失效时自动重登后成功", async () => {
  await withFake(async (fake) => {
    const { hooks } = await makePlugin()
    const auth = await signInAs(hooks)
    const logins = fake.counters.logins
    // 模拟会话中途失效：服务端换了 JWT，旧 cookie 不再有效；重登后拿到新 JWT
    fake.setJwt(fakeJwt(Date.now() + 3600_000))
    const usage = (await hooks.auth.usage(async () => auth)) as { plan: string }
    assert.equal(usage.plan, "Token 中心")
    assert.equal(fake.counters.logins, logins + 1)
  })
})

test("refresh：重登并返回新 access/expires", async () => {
  await withFake(async (fake) => {
    const { hooks } = await makePlugin()
    const auth = await signInAs(hooks)
    const logins = fake.counters.logins
    const fields = (await hooks.auth.refresh(auth)) as Record<string, unknown>
    assert.ok((fields.access as string).length > 20)
    assert.ok((fields.expires as number) > Date.now())
    assert.equal(fake.counters.logins, logins + 1)
  })
})

test("checkin：可领取 → claimed", async () => {
  await withFake(async (fake) => {
    fake.state.tasks = [dailyTask()]
    const { hooks } = await makePlugin()
    const auth = await signInAs(hooks)
    const r = (await hooks.auth.checkin(async () => auth)) as Record<string, unknown>
    assert.equal(r.outcome, "claimed")
    assert.equal(r.credit, 100_000)
    assert.equal(fake.counters.receivePoints, 1)
  })
})

test("checkin：每日签到后自动领取连续7天奖励", async () => {
  await withFake(async (fake) => {
    fake.state.tasks = [dailyTask(), streakTask()]
    fake.state.onReceive = (taskDefId) => {
      fake.state.tasks =
        taskDefId === 3001
          ? [dailyTask({ canReceive: false, status: 2 }), streakTask()]
          : [
              dailyTask({ canReceive: false, status: 2 }),
              streakTask({ canReceive: true, status: 2, receiveDate: Date.now() }),
            ]
    }
    const { hooks } = await makePlugin()
    const auth = await signInAs(hooks)
    const r = (await hooks.auth.checkin(async () => auth)) as Record<string, unknown>
    assert.equal(r.outcome, "claimed")
    assert.equal(r.credit, 1_100_000)
    assert.equal(r.streak, 7)
    assert.match(r.message as string, /连续7天签到奖励/)
    assert.equal(fake.counters.receivePoints, 2)

    const receives = fake.requests.filter((req) => req.url.includes("/userPoints/receivePointsV2"))
    assert.match(receives[0].url, /taskDefId=3001/)
    assert.match(receives[1].url, /taskDefId=3002&progress=7/)
  })
})

test("checkin：今日已签到时补领连续7天奖励", async () => {
  await withFake(async (fake) => {
    fake.state.tasks = [dailyTask({ canReceive: false, status: 2 }), streakTask()]
    const { hooks } = await makePlugin()
    const auth = await signInAs(hooks)
    const r = (await hooks.auth.checkin(async () => auth)) as Record<string, unknown>
    assert.equal(r.outcome, "claimed")
    assert.equal(r.credit, 1_000_000)
    assert.equal(r.streak, 7)
    assert.equal(fake.counters.receivePoints, 1)
  })
})

test("checkin：连续7天奖励领取后 canReceive 仍为 true 也不重复领取", async () => {
  await withFake(async (fake) => {
    fake.state.tasks = [
      dailyTask({ canReceive: false, status: 2 }),
      streakTask({ canReceive: true, status: 2, receiveDate: Date.now() }),
    ]
    const { hooks } = await makePlugin()
    const auth = await signInAs(hooks)
    const r = (await hooks.auth.checkin(async () => auth)) as Record<string, unknown>
    assert.equal(r.outcome, "done")
    assert.equal(fake.counters.receivePoints, 0)
  })
})

test("checkin：已签到 → done，不重复领取", async () => {
  await withFake(async (fake) => {
    fake.state.tasks = [dailyTask({ canReceive: false, status: 2 })]
    const { hooks } = await makePlugin()
    const auth = await signInAs(hooks)
    const r = (await hooks.auth.checkin(async () => auth)) as Record<string, unknown>
    assert.equal(r.outcome, "done")
    assert.equal(fake.counters.receivePoints, 0)
  })
})

test("checkin：领取被拒（重复签到）→ 复查后 done", async () => {
  await withFake(async (fake) => {
    fake.state.tasks = [dailyTask()]
    fake.state.receiveRefusal = "今日已签到"
    fake.state.onReceiveRefused = (taskDefId) => {
      if (taskDefId === 3001) fake.state.tasks = [dailyTask({ canReceive: false, status: 2 })]
    }
    const { hooks } = await makePlugin()
    const auth = await signInAs(hooks)
    const r = (await hooks.auth.checkin(async () => auth)) as Record<string, unknown>
    assert.equal(r.outcome, "done")
    assert.equal(fake.counters.receivePoints, 1)
  })
})

test("checkin：无每日任务 → inactive", async () => {
  await withFake(async (fake) => {
    fake.state.tasks = []
    const { hooks } = await makePlugin()
    const auth = await signInAs(hooks)
    const r = (await hooks.auth.checkin(async () => auth)) as Record<string, unknown>
    assert.equal(r.outcome, "inactive")
  })
})

test("checkin：未登录 → failed", async () => {
  const { hooks } = await makePlugin()
  const r = (await hooks.auth.checkin(async () => null)) as Record<string, unknown>
  assert.equal(r.outcome, "failed")
})

test("models：无 auth 返回空表；有 auth 时按上游清单并跟随协议开关", async () => {
  const { hooks: hooksA } = await makePlugin()
  const declared = (await hooksA.provider.models({ models: {} }, {})) as Record<string, unknown>
  assert.deepEqual(declared, {})
  // 即使宿主给了声明列表，没有登录态也不提供
  const custom = await hooksA.provider.models(
    { models: { custom: { name: "Custom", api: { npm: "@ai-sdk/openai-compatible" } } } },
    {},
  )
  assert.deepEqual(custom, {})

  await withFake(async () => {
    const magpie = { option: (_p: string, key: string) => key === "use_openai" ? false : undefined }
    const { hooks } = await makePlugin(magpie)
    const auth = await signInAs(hooks)
    const switched = (await hooks.provider.models({ models: {} }, { auth })) as Record<
      string,
      { api: { npm: string } }
    >
    assert.equal(switched["glm-5.3-oc"].api.npm, "@ai-sdk/anthropic")
  })
})

test("models：登录后按上游清单返回（新模型与上游展示名）", async () => {
  await withFake(async (fake) => {
    fake.state.models.push({
      id: 99,
      title: "Future Model",
      model: "future-model",
      api: "openai-completions",
    })
    const { hooks } = await makePlugin()
    const auth = await signInAs(hooks)
    const models = (await hooks.provider.models({ models: {} }, { auth })) as Record<
      string,
      { name: string; api: { npm: string }; limit: { context: number; output: number } }
    >
    assert.deepEqual(Object.keys(models), [
      "deepseek-v4.1-flash",
      "glm-5.3-flash",
      "deepseek-v4-pro-0813-oc",
      "glm-5.3-oc",
      "qwen-3.8-flash",
      "future-model",
    ])
    assert.equal(models["deepseek-v4.1-flash"].name, "DeepSeek-V4.1-Flash-1017")
    assert.equal(models["deepseek-v4.1-flash"].limit.context, 1_048_576)
    // 未在 MODEL_SPECS 中映射的新模型使用保守默认值
    assert.equal(models["future-model"].limit.context, 128_000)
    assert.equal(models["future-model"].limit.output, 32_000)
    assert.equal(models["future-model"].api.npm, "@ai-sdk/openai-compatible")
  })
})

test("models：按上游 api 字段过滤协议", async () => {
  await withFake(async (fake) => {
    fake.state.models = [
      { id: 1, title: "Both", model: "both", api: "openai-completions,anthropic-messages" },
      { id: 2, title: "OpenAI Only", model: "openai-only", api: "openai-completions" },
      { id: 3, title: "Anthropic Only", model: "anthropic-only", api: "anthropic-messages" },
    ]
    const { hooks } = await makePlugin()
    const auth = await signInAs(hooks)
    const openai = (await hooks.provider.models({ models: {} }, { auth })) as Record<string, unknown>
    assert.deepEqual(Object.keys(openai), ["both", "openai-only"])

    const magpie = { option: (_p: string, key: string) => key === "use_openai" ? false : undefined }
    const { hooks: hooksAnthropic } = await makePlugin(magpie)
    const authAnthropic = await signInAs(hooksAnthropic)
    const anthropic = (await hooksAnthropic.provider.models({ models: {} }, { auth: authAnthropic })) as Record<
      string,
      unknown
    >
    assert.deepEqual(Object.keys(anthropic), ["both", "anthropic-only"])
  })
})

test("models：同一会话内缓存上游清单", async () => {
  await withFake(async (fake) => {
    const { hooks } = await makePlugin()
    const auth = await signInAs(hooks)
    const before = fake.counters.modelLists
    await hooks.provider.models({ models: {} }, { auth })
    await hooks.provider.models({ models: {} }, { auth })
    assert.equal(fake.counters.modelLists, before + 1)
  })
})

test("models：上游清单失败时返回空表", async () => {
  await withFake(async (fake) => {
    fake.state.modelsResultCode = -1
    const { hooks } = await makePlugin()
    const auth = await signInAs(hooks)
    const models = (await hooks.provider.models(
      { models: { custom: { name: "Custom", api: { npm: "@ai-sdk/openai-compatible" } } } },
      { auth },
    )) as Record<string, unknown>
    assert.deepEqual(models, {})
  })
})

test("loader：默认 OpenAI；magpie.option 与插件 options 可切回 Anthropic", async () => {
  await withFake(async () => {
    const { hooks } = await makePlugin()
    const auth = await signInAs(hooks)
    const loader = await hooks.auth.loader(async () => auth)
    assert.equal(loader.baseURL, "https://eaichat.ctyun.cn/ai/platform/v2/cp")

    // GUI 开关关掉 -> Anthropic
    const magpie = { option: (_p: string, key: string) => (key === "use_openai" ? false : undefined) }
    const { hooks: hooksOff } = await makePlugin(magpie)
    const authOff = await signInAs(hooksOff)
    const loaderOff = await hooksOff.auth.loader(async () => authOff)
    assert.equal(loaderOff.baseURL, "https://eaichat.ctyun.cn/ai/platform/v2/cp/anthropic/v1")

    // plugins.json 的 options（CLI `magpie plugin options` 写入）也能关
    const hooks2 = await EAIChatPlugin(
      {
        client: {
          auth: { set: async () => ({ data: undefined }) },
          app: { log: async () => ({ data: undefined }) },
        },
      },
      { use_openai: false },
    )
    const auth2 = await signInAs(hooks2)
    const loader2 = await hooks2.auth.loader(async () => auth2)
    assert.equal(loader2.baseURL, "https://eaichat.ctyun.cn/ai/platform/v2/cp/anthropic/v1")
  })
})
