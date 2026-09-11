# v1 模型系统：Managed Agents、Model Card 与 Pi

本文描述 v1 当前可执行的模型边界。核心原则是：Managed Agents API 管官方
shape，Model Card 管租户可执行绑定，Pi 管 provider/model 协议与能力。

## 两套模型目录

| 接口 | 用途 | 是否接收 provider key |
|---|---|---|
| `GET /v1/models`、`GET /v1/models/:id` | 官方 Managed Agents Models。数据源是当前租户未归档的 Model Card，能力、显示名和 token 上限由 Pi 元数据保守投影。 | 否 |
| `POST /v1/oma/models/list` | 创建 Model Card 时浏览某个 Pi 内置 provider 的模型目录。请求只需 `{ "provider": "deepseek" }`。 | 新路径不需要；`api_key` 只为 0.x Anthropic/OpenAI 在线目录兼容保留 |

自定义 provider 没有静态目录；直接创建 Model Card，并用 `pi_config.api`
告诉 Pi 采用哪一种 wire protocol。

## Model Card 的职责

Model Card 是租户级可执行绑定，字段职责如下：

- `model_id`：Agent 引用的稳定 handle；
- `model`：发给 provider 的 wire model id；
- `provider`：开放的 Pi provider id；
- `api_key`、`base_url`、`custom_headers`：认证与路由；
- `pi_config`：Pi Model 的可序列化元数据。

`provider` 不是 OpenMA enum。`anthropic`、`openai`、`deepseek`、
`openrouter`、`google`、`minimax` 等 Pi 内置 id 都可以使用。`ant`、`oai`、
`ant-compatible`、`oai-compatible` 仅作为迁移别名保留。

自定义 provider 必须给出 `base_url` 与 `pi_config.api`。`pi_config` 可包含
`name`、`api`、`reasoning`、`thinkingLevelMap`、`input`、`cost`、
`contextWindow`、`maxTokens`、`samplingParams`、`headers`、`compat`；它不能
覆盖 Card 的 handle、wire model、provider、endpoint 或 credential。

凭据用 `PLATFORM_ROOT_SECRET` 加密保存。list/retrieve 只返回 preview，不返回
明文。创建时的 6 秒 live probe 目前覆盖旧 Anthropic/OpenAI protocol；其他
Pi provider 返回 `ok:null, reason:"unsupported_provider"` 表示“未探测”，不是
“Pi 不支持运行”。

## Agent 模型控制

`effort`、`speed`、`inference_geo` 属于 Agent version，不属于 Model Card。
Session 固定一个 Agent version，因此自然继承这组控制。

```json
{
  "model": {
    "id": "deepseek-fast",
    "effort": { "type": "high" },
    "speed": "standard",
    "inference_geo": "us"
  }
}
```

| 字段 | 当前语义 |
|---|---|
| `id` | 解析当前租户的 `model_id`，再得到 wire model 与 Pi provider。 |
| `effort` | 映射到 Pi `thinkingLevel`。Pi 根据模型的 `thinkingLevelMap` 把不支持的档位归一化到最近可用档位，例如 DeepSeek V4 Flash 的 `medium` 会变成 `high`。 |
| `speed: standard` | 不改变 Pi/provider 默认请求。 |
| `speed: fast` | Anthropic 映射为 fast mode body + beta header；OpenAI Responses/Codex 映射为 Pi `serviceTier: priority`，OpenAI Completions 映射为 `service_tier: priority`。其他 Pi API 明确报 unsupported，不静默忽略。 |
| `inference_geo` | API 校验、存储、版本化与回读均保留；运行时暂不根据它选择 region/provider。 |

官方 Models capability 是 Pi 元数据的保守投影：只有 Pi 明确表达的
thinking/effort/image/strict-output 才标为支持；citation、batch、PDF、code
execution、context management 不会仅凭猜测标为支持。

## SDK 对应关系

```ts
const executable = await client.beta.models.list();
const available = await client.oma.models.list({ provider: "deepseek" });
const card = await client.oma.modelCards.create({
  model_id: "deepseek-fast",
  provider: "deepseek",
  model: "deepseek-v4-flash",
  api_key: process.env.DEEPSEEK_API_KEY!,
});
```

`client.beta` 是真实 `@anthropic-ai/sdk` resource tree；`client.oma` 只承载
OpenMA 扩展。两者复用同一个官方 transport、错误类型、重试和租户 header。
