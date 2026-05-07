# Linear 集成 —— 当前架构（M7 之后）

**状态**：线上已生效，截至 2026-04-23 代码里就是这个样子
**前身**：[`linear-integration-design.md`](./linear-integration-design.zh-CN.md) —— 原设计文档，部分已被替换；可作为历史背景阅读

---

## TL;DR

Bot 是 Linear 里的一等 teammate。**所有对 Linear 可见的输出都通过显式的 MCP tool call** —— 不存在自动镜像 bot 内部推理的机制。**Bot 自己决定哪些要露出、哪些保持私有、何时把 panel 终结。**服务端只有 2 张 D1 表 + 1 个 MCP server。**没有按回合可变的 KV 状态。没有 event-tap。**

---

## 心智模型

```
                   Linear
                   ──────
                     │
        webhooks ↓   │ ↑ GraphQL（由 tool 触发）
                     │
       ┌─────────────┼─────────────────────────────────────┐
       │  apps/integrations（gateway worker）             │
       │  ┌──────────────────┐  ┌────────────────────┐   │
       │  │  webhook 路由    │  │  MCP server        │   │
       │  │  /linear/webhook │  │  /linear/mcp/:sess │   │
       │  │  解析 + 派发     │  │  3 个工具          │   │
       │  └────────┬─────────┘  └─────────▲──────────┘   │
       └───────────│─────────────────────│───────────────┘
                   │                     │
                   │ user.message         │ tool call
                   ▼                     │
       ┌──────────────────────────────────────────────────┐
       │  apps/main（OMA） →  apps/agent（SessionDO）     │
       │  bot 跑在这里，通过 tool 决定何时说话             │
       └──────────────────────────────────────────────────┘
```

两条通道：

- **Input**（Linear → bot）：webhook 解析后以 `user.message` 派发到 bot 的 OMA session
- **Output**（bot → Linear）：bot 调 MCP tool 把任何用户可见的内容发出去

**没有自动镜像层**。Bot 的内部 `thought` / `tool_use` 事件全留在 OMA；除非 bot 主动调 tool，否则什么也不会落到 Linear。

---

## Tool 表面（3 个）

### `linear_say(body, panelId, kind, action?, parameter?)`

往 Linear panel 发一条 `AgentActivity`。这是 bot 在 panel 内部「公开发声」的方式。

| `kind` | panel 状态 | 用途 |
|---|---|---|
| `thought`（默认） | 仍 `active` | 「正在检查代码…」之类的进度叙述 |
| `action` | 仍 `active` | 结构化 tool-call 卡片（传 `action`，可选 `parameter`） |
| `elicitation` | 翻为 `awaitingInput` | 向 panel 创建者提问，渲染内联回复框 |
| `response` | 翻为 `complete` | 最终答案，**panel 死掉** |

**顺序规则：**

- 发了 `kind=elicitation` 之后，**用户回复之前不要**再往同一 panel 发任何东西——Linear 当前正在显示输入框，多余 activity 会覆盖它。
- 发了 `kind=response` 之后，panel 死掉。API 仍接受后续 activity，但 UI 不再渲染。Linear 会为用户的下一次交互生成新的 panel。

**`panelId`** 是唤醒 bot 的那条 user-message 中显式指明的（如 `Linear panel ag_xxx for this turn`）。Bot 自己一路串下去。

### `linear_post_comment(body, parentId?, issueId?)`

以 bot 用户的身份发一条 Linear 评论。**与任何 panel 都无关。**

- 不传 `parentId` → 顶级评论（开新线程）。用于通过 `@`-mention 触达另一个人。
- 传 `parentId` → 线程回复。**Linear 的线程结构是扁平的（2 层）**，所有回复都挂在最初的顶级评论下。
- `issueId` 缺省取本次会话所绑定的 issue。
- `@`-mention 用普通 `@<displayname>` 写——Linear 服务端会解析成真实的 mention chip + 发通知。

如果某个人在 bot 开的线程里回复，那条回复会作为下一条 user message 回到 bot 这里。

### `linear_get_issue(issueId?, parentCommentId?)`

读取一个 issue 的完整状态以及评论历史（最多 50 条）。传 `parentCommentId` 可缩到一个线程（父 + 回复）。

返回：identifier、title、description、status、priority、labels、assignee、creator、URL，以及评论列表。

什么时候用：bot 唤醒时上下文太薄、状态可能已变、或者要引用过去评论之前。

---

## 触发源（3 条 webhook → user.message 路径）

### 1. `agentSessionCreated`

何时触发：

- Linear UI：有人把 issue 委派给 bot，或者有人 `@`-mention bot
- API：服务端调 `agentSessionCreateOnIssue` mutation（我们的测试 workaround）

`user.message` 内容：

```
# Linear agent session — newly opened
**Issue:** OPE-25
**Issue UUID:** `...`  ← 工具想要 issueId 时用这个
**Actor:** @hrhrngxy
**Linear panel:** `ag_xxx`
**Title:** ...
**Description:** ...
**Source comment:** ...（如果是通过评论里 @-mention 委派的）
[hint: linear_say(..., panelId="ag_xxx", kind=...) to speak in the panel]
```

### 2. `agentSessionPrompted`

何时触发：panel 创建者在 panel 的内联回复框里回复（在前一次 `kind=elicitation` 之后）。

形态与 #1 相同，但头部写「new prompt」，`Source comment` 携带用户的回复。

### 3. `commentReply`

何时触发：人类在 bot 写过的评论上发线程回复。通过 `linear_authored_comments` D1 lookup 路由。

`user.message` 内容：

```
# Linear thread reply
**Issue:** OPE-23
**Issue UUID:** `...`
**Thread anchor comment:** <bot 写的原评论 id>
**Replier:** @hrhrngxy
> <被引用的回复 body>
[hint: linear_post_comment(body=..., parentId="<anchor>") to respond in the thread]
```

**这一回合没有 panel**；bot 必须用 `linear_post_comment` 才能可见地回复。

### 故意不触发

- 任何评论的 parent 不在 `linear_authored_comments` 里 → kind=null，丢弃
- Issue 字段变更（状态 / 标签 / 标题）→ 忽略
- Bot 自己的评论（`actorUserId === installation.botUserId`）→ 丢弃以防自循环

（后续迭代可能加一条「环境观察」通道——见下文「限制」。）

---

## 服务端状态

两张 D1 表。KV `metadata.linear` 是不可变的。

```sql
linear_authored_comments (
  comment_id      TEXT PRIMARY KEY,   -- Linear 评论 id（UUID）
  oma_session_id  TEXT NOT NULL,      -- 是哪个 bot session 写的
  issue_id        TEXT NOT NULL,      -- Linear issue UUID（必须 UUID，不是 identifier）
  created_at      INTEGER NOT NULL
);
```

反向索引：「Linear 评论 id → 它属于哪个 bot session」。Webhook 路由用它把线程回复路由回正确的 OMA session。

```sql
linear_issue_sessions (
  publication_id  TEXT,
  issue_id        TEXT,                -- Linear issue UUID
  session_id      TEXT,                -- OMA session id
  status          TEXT,                -- active | inactive
  created_at      INTEGER,
  PRIMARY KEY (publication_id, issue_id)
);
```

per-issue 的 OMA session 复用（保证同一 issue 的多次 AgentSessionEvent 续接同一 bot session，而不是每次新建）。

KV `metadata.linear`：

```json
{
  "publicationId": "...",   // 哪个 OAuth app
  "mcp_token": "...",       // per-session 的 UUID，用于 MCP 鉴权
  "mcp_url": "...",         // 托管的 MCP endpoint
  "issueId": "..."          // 绑定的 issue UUID
}
```

**全部 per-session 不可变**。会话进行中没有任何字段被改写。

---

## OAuth 生命周期

Linear 的 `actor=app` 授权码流返回 24 小时的 `access_token` + 一个 `refresh_token`。两者都在 `linear_installations` 中以 AES-GCM 加密存储。

`LinearProvider.refreshAccessToken(installationId)` 在按需触发时跑 OAuth 刷新（在 tool 处理器收到 Linear 返回 `AUTHENTICATION_ERROR` 时调用）。新 token 持久化、vault bearer 为 sandbox MITM 注入层轮换、失败的调用重试一次。

刷新路径上线之前创建的安装没有存 `refresh_token`。对它们而言，有个管理员端点（`/admin/linear-reauth-link`）会生成 Linear 同意 URL，用户批准后跑一次 OAuth 流程，原地更新 token。

---

## 常见模式

### Bot 被委派到一个 issue（panel 模式）

```
1. webhook AgentSessionEvent.created（panel=ag_X）
2. provider 创建/续接 per_issue 的 OMA session，派发 user.message
3. bot 读上下文，必要时调 linear_get_issue 拿更多信息
4. bot 调 linear_say(thought) 叙述进度（可选）
5. bot 调 linear_say(response) 给最终答案 → panel 进入 complete
```

### Bot 拉另一个人进来（thread 模式）

```
1. bot 在 panel ag_X（Case A）
2. bot 调 linear_post_comment(body="@bob can you confirm?", issueId=...)
3.（panel UX 独立继续）
4. bob 在该线程回复，没有 @ bot
5. webhook Comment.create，parentId 命中 linear_authored_comments
6. provider 走 commentReply 路径，派发描述该回复的 user.message
7. bot 在 panel 之外被唤醒，用 linear_post_comment(parentId=anchor) 回复
8. 多轮继续；每条可见回复都由 bot 负责
```

### Bot 需要结构化答复（elicitation）

```
1. bot 在 panel ag_X
2. bot 调 linear_say(kind=elicitation, body="staging or prod?", panelId=ag_X)
3. panel UI 翻为 awaitingInput，给委派者渲染内联回复框
4. bot 停下（本回合不再发 activity）
5. 委派者在 panel 里回复
6. webhook AgentSessionEvent.prompted → user.message
7. bot 处理回复，继续干活
```

---

## Linear 侧的限制

| 限制 | Workaround |
|---|---|
| 通过 API 发的 `@<bot>` 文本不会触发 `AgentSessionEvent`（只有 Linear UI 编辑器能） | `agentSessionCreateOnIssue` mutation 可在服务端开 panel |
| 通过 API 发的评论需要 `bodyData`（ProseMirror JSON）才能渲染 mention chip（纯 markdown body 不行） | 我们让 bot 以纯 `@<displayname>` 文本发送，由 Linear 服务端解析成 chip + 发通知（针对人类目标可行） |
| panel 一旦发出 `response` 就 `complete` —— 后续 activity API 接受但 UI 不渲染 | 真没干完之前别发 `response`；预期还有对话就用 `thought` |
| Linear 线程结构是扁平的（2 层）—— 所有回复都挂在 root | 把 thread anchor（root）当对话 key；bot 的所有回复都挂它 |
| panel response activity 也会以行内评论的形式呈现在 issue thread 中 | bot 在 panel 里 `say` 的内容**所有订阅者公开可见**——按评论级别考量敏感度 |

---

## 后续工作（本次迭代不做）

### Steer vs non-steer 事件

目前每条触达 bot 管理 issue/comment 的 webhook 都会产生一条 `user.message`，并消耗一次 LLM turn。**bot 不得不为每个事件回应（或显式保持沉默）。**

更经济的模型把事件拆成两条通道：

- **Steer** —— 显式行动召唤（委派、panel 回复、bot 写过的线程上的回复）。会唤醒 bot，期待响应。
- **Non-steer** —— 环境观察（订阅 issue 上的其它评论、状态变更、标签调整）。bot 在上下文里看到，但未必要响应。

实现需要 SessionDO 支持「不触发 LLM turn 的通知事件」——本次不范围。

### 订阅整个 issue

今天 bot 只看到：

- AgentSessionEvent webhook（Linear 原生 panel 触发）
- Comment.create 且 parent 在 `linear_authored_comments` 里（bot 线程的回复）

**不**看到：

- 它被委派的 issue 上的其它评论
- 那些 issue 上的字段变更（状态 / 标签 / 标题 / 描述编辑）

加这一条需要先做 steer/non-steer 拆分（否则 bot 会被噪声淹没）。

---

## 文件

| 文件 | 用途 |
|---|---|
| `apps/integrations/src/routes/linear/mcp.ts` | MCP server：tool 注册 + JSON-RPC 处理 |
| `apps/integrations/src/routes/linear/webhook.ts` | webhook 接收、签名校验 |
| `apps/integrations/src/routes/linear/dedicated-callback.ts` | OAuth callback（install + reauth） |
| `packages/linear/src/provider.ts` | webhook 解析、派发、OAuth 刷新 |
| `packages/linear/src/webhook/parse.ts` | webhook 信封归一 |
| `apps/main/migrations/0008_linear_authored_comments.sql` | D1 schema |

本轮迭代删除的：

- `apps/integrations/src/routes/linear/event-tap.ts`（自动镜像 —— 砍掉）
- `apps/main/migrations/0009_linear_oma_panel_binding.sql`（panel 绑定 D1 表 —— 砍掉）
- `linear_enter_panel` / `linear_exit_panel` MCP tool（不再有隐式绑定 —— bot 每次自己传 panelId）
- `metadata.linear.{currentAgentSessionId,triggerCommentId,lastElicitationAt,actor}`（可变字段 —— 砍掉）

---

## 端到端测试覆盖

| 用例 | Issue | 结果 |
|---|---|---|
| 基本委派 + linear_say 生命周期 | OPE-36 | ✅ |
| Bot post_comment + 3 轮纯线程回复 | OPE-38 | ✅ |
| 通过 linear_say(kind=elicitation) 做 elicitation | OPE-37 | ✅ panel 进入 `awaitingInput` |
| `linear_get_issue` 工具返回 issue + 线程上下文 | OPE-41 | ✅ |
| Elicitation→response 状态机（不存盘） | OPE-42 | ✅ panel 进入 `complete` |
| Bot 自循环防护（`actor=bot` 过滤） | OPE-38 | ✅ webhook 在 `comment_reply_from_bot_self` 处丢弃 |
| 无关的顶级评论不会唤醒 bot | OPE-40 | ✅ `ignored_event_Comment` |

通过 Linear UI 编辑器 `@bot`（Case 3）—— 仅手工验证，没有 API 路径。