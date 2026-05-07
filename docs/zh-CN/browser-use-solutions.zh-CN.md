# 云端 Agent 浏览器使用方案

## 问题

云端 agent 需要浏览器自动化能力：

- 与网页交互（登录、点击、抓取）
- 维护已认证 session（cookie、OAuth token）
- 让用户实时观看 agent 操作浏览器（Manus 风格）

## 方案全景

### 对比矩阵

| | Cloudflare Browser Rendering | Browserbase | noVNC + Container |
|---|---|---|---|
| 本质 | 远程 Chrome + CDP 透传 | 远程 Chrome + CDP 透传 + 封装 | 虚拟桌面 + VNC 流 |
| 资源开销 | 一个 Chrome 进程（~200-400MB） | 一个 Chrome 进程（~200-400MB） | Xvfb + Chrome + VNC Server（~1-2GB） |
| 实时画面 | CDP screencast（自己实现） | Live View（内置，一行代码） | 完整桌面流 |
| Cookie 持久化 | 自己实现（KV 存取） | 内置 Context 功能 | 容器内文件系统 |
| 反爬/隐身 | Web Bot Auth | Stealth Mode + 代理 | 真实浏览器环境 |
| AI 控制 | Stagehand（自然语言） | 无内置 | 无内置 |
| 与本项目集成 | **原生 binding，零网络开销** | 外部 API 调用 | 需要定制容器镜像 |
| 定价 | 有免费额度，按用量计费 | 按 session 分钟计费 | 容器资源费用 |

**结论：Cloudflare Browser Rendering 是最优选择** —— 原生集成、最轻量、完全够用。Browserbase 的优势（Live View、Context）我们可以用 CDP screencast + KV 自己实现。noVNC 太重，杀鸡用牛刀。

---

## Cloudflare Browser Rendering 深度分析

### 架构原理

Cloudflare 在边缘节点管理 Chrome 进程池，通过 WebSocket 暴露标准 CDP（Chrome DevTools Protocol）：

```
你的代码（Worker / 本地 / 任何地方）
  │
  │  WebSocket
  │  wss://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/
  │       browser-rendering/devtools/browser?keep_alive=600000
  │  Header: Authorization: Bearer <API_TOKEN>
  │
  ▼
Cloudflare 边缘节点
  │  分配 Chrome 实例
  │  WebSocket 双向转发 CDP 消息
  │  大消息用 4-byte little-endian 长度前缀分片（绕过 1MB WebSocket 帧限制）
  │
  ▼
Chromium 进程（Cloudflare 管理）
  └── 标准 CDP 协议，和 chrome://inspect 用的一模一样
```

CDP 就是 Chrome F12 DevTools 和浏览器之间的通信协议——一组 JSON-RPC 消息：

```
→ {"method":"Page.navigate","params":{"url":"https://google.com"},"id":1}
← {"id":1,"result":{"frameId":"ABC123"}}
```

Puppeteer 和 Playwright 只是这些 JSON 消息的封装库。Cloudflare 做的事：管理 Chrome 进程池 + WebSocket 透传。

### 四种使用方式

1. **REST API** —— 无需部署，直接 curl 截图/PDF/抓取
2. **Workers Binding** —— Worker 内 Puppeteer/Playwright 完整控制
3. **CDP 直连** —— 任何环境通过 WebSocket 连接，用标准 CDP 或 Puppeteer/Playwright
4. **Stagehand** —— 用自然语言指令操控浏览器，底层是 Workers AI

### Session 生命周期

| 方式 | 持续时间 | 适用场景 |
|---|---|---|
| 单次请求 | 请求结束即关闭 | 截图、抓取 |
| disconnect/reconnect | 空闲超时前可重连 | 短间隔多次操作 |
| Durable Object 保活 | alarm 续命，默认 60 秒空闲 | 同用户连续操作 |
| CDP keep_alive | 最长 10 分钟 | 远程长连接 |

### 参考链接

- https://developers.cloudflare.com/browser-rendering/
- https://developers.cloudflare.com/browser-rendering/cdp/playwright/
- https://developers.cloudflare.com/browser-rendering/stagehand/
- https://developers.cloudflare.com/browser-rendering/workers-bindings/reuse-sessions/
- https://developers.cloudflare.com/browser-rendering/workers-bindings/browser-rendering-with-do/

---

## 实时画面方案（Manus 风格）

### 核心发现：Live View = 前端直连 CDP，就一行代码

browser-use 开源代码（`browser_use/skill_cli/daemon.py:306`）揭示了 live view 的真相：

```python
# browser-use 的 live_url 生成逻辑，就这一行：
result_data['live_url'] = f'https://live.browser-use.com/?wss={quote(bs.cdp_url, safe="")}'
```

`live.browser-use.com` 只是一个静态前端页面，从 URL 的 `wss` 参数拿到 CDP WebSocket 地址，直连 Chrome。**没有中间层，没有 relay，没有额外服务。整个「live view 产品」= 一个前端页面 + 一行 URL 拼接。**

Browserbase 的 Live View 也是同理 —— 返回一个可嵌入的 URL，背后连 CDP。

### 实测验证（2026-04-12）

本地实测 browser-use live view 成功：

```bash
# 1. 启动 headless Chrome（关键：--remote-allow-origins=*）
chrome --headless --remote-debugging-port=9222 '--remote-allow-origins=*'

# 2. 拿 browser 级别的 CDP URL（不是 page 级别！）
curl -s http://localhost:9222/json/version | jq -r .webSocketDebuggerUrl
# → ws://localhost:9222/devtools/browser/xxxxx

# 3. 拼 live URL（和 daemon.py:306 一样的逻辑）
# https://live.browser-use.com/?wss=ws%3A%2F%2Flocalhost%3A9222%2Fdevtools%2Fbrowser%2Fxxxxx

# 4. 浏览器打开 → 实时看到 headless Chrome 的画面（地址栏、tab、页面内容）
```

**踩坑记录：**

- 必须用 **browser 级别** URL（`/devtools/browser/...`），**不能用 page 级别**（`/devtools/page/...`）。因为 `live.browser-use.com` 前端需要调 `Target.getTargets` 发现页面，这只在 browser 级别可用。
- Chrome 必须加 `--remote-allow-origins=*`，否则 CDP WebSocket 会拒绝来自 `live.browser-use.com` 的跨域连接（错误码 1006）。
- CDP screencast 是变化驱动的，静态页面只推 1 帧，有交互/动画时才密集推帧。
- 实测首帧延迟 9ms，帧大小 ~15-19KB（JPEG quality 70-80）。

### live.browser-use.com 前端源码分析

通过 `eval` 提取的 Next.js 源码（`app/page-*.js`）确认前端逻辑：

```
CDPClient(wsUrl).connect()
  → Target.setDiscoverTargets({discover: true})
  → Target.getTargets() → 过滤 type === 'page'
  → Target.attachToTarget({targetId}) → 拿到 sessionId
  → Page.startScreencast({format:'jpeg', quality:80, ...})
  → Page.screencastFrame 事件 → 渲染到 canvas
  → Page.screencastFrameAck → 确认后推下一帧
  → 用户输入 → Input.dispatchMouseEvent / Input.dispatchKeyEvent
```

### 前端连上 CDP 后做什么

1. `Target.getTargets` → 发现所有 page 类型的 target（需要 browser 级别连接）
2. `Target.attachToTarget` → 附加到具体页面，获取 sessionId
3. `Page.startScreencast` → Chrome 自动推 JPEG 帧
4. `Page.screencastFrame` 事件 → 前端渲染到 canvas
5. `Page.screencastFrameAck` → 确认后 Chrome 推下一帧
6. 用户点击/键盘 → `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` 注入

Vercel agent-browser（`cli/src/native/stream/cdp_loop.rs`）提供了完整的开源实现：

- CDP screencast 帧通过 WebSocket 广播给所有连接的客户端
- 按需开关：有客户端连上才开 screencast，没人看就关
- 支持 viewport 变化、tab 切换时自动重启 screencast
- 双向交互：前端的 mouse/keyboard 事件通过 CDP `Input.dispatch*` 注入

### 对我们的实现方案

**最简方案（和 browser-use 一样）：**

```
1. Agent 通过 Cloudflare Browser Rendering 拿到 CDP WebSocket URL
2. 拼一个 live view 前端页面的 URL：
   `https://our-console.com/live?wss=${encodeURIComponent(cdpUrl)}`
3. Console UI 嵌 iframe 或直接在页面内连 CDP
4. 完了
```

**稍完整的方案（参考 Vercel agent-browser）：**

```
Cloudflare Browser Rendering
  └── Chrome 实例（CDP WebSocket）

StreamServer（在 SessionDO 或独立 Worker 中）
  ├── 连接 Chrome CDP
  ├── Page.startScreencast（有人看时开，没人看时关）
  ├── 收 screencastFrame → broadcast 给所有 WebSocket 客户端
  ├── 收用户输入 → Input.dispatch* 注入 Chrome
  └── 额外：广播 URL 变化、console 日志、tab 列表

Console UI
  └── WebSocket 连 StreamServer
        ├── 渲染帧到 <canvas>
        └── 捕获点击/键盘 → 发送给 StreamServer
```

中间加一层 StreamServer 的好处：

- 前端不直接暴露 CDP URL（安全）
- 可以多人同时观看同一个浏览器
- 可以控制权限（谁能看、谁能操作）
- 可以叠加额外信息（agent 正在执行的 action、console 日志等）

### 示例代码

```js
// 连接 Cloudflare Browser Rendering
const browser = await puppeteer.connect({
  browserWSEndpoint: `wss://api.cloudflare.com/.../devtools/browser?keep_alive=600000`,
  headers: { Authorization: `Bearer ${API_TOKEN}` }
})

const page = await browser.newPage()

// 开启 screencast —— Chrome 自动按帧推 JPEG
const cdp = await page.createCDPSession()
await cdp.send('Page.startScreencast', {
  format: 'jpeg',
  quality: 50,
  maxWidth: 1280
})

cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
  // data = base64 JPEG 帧
  // 通过已有 WebSocket 推给前端
  broadcastToConsole({ type: 'browser_frame', data })
  // 必须 ack，Chrome 才会推下一帧
  cdp.send('Page.screencastFrameAck', { sessionId })
})

// agent 正常操作页面，用户同时看到画面
await page.goto('https://example.com')
await page.click('#login')
```

### 用户交互（Human-in-the-loop）

用户不只是看，还能介入操作：

```
前端 → WebSocket → SessionDO → CDP

用户点击画面坐标 (x, y):
  → cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1
    })

用户键盘输入:
  → cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Enter'
    })
```

Agent 和用户可以交替操控同一个浏览器。

---

## 认证与凭据管理

### 首次认证

所有方案在面对强风控网站（Google 等）时，**首次都需要人工介入**。关键是把人工成本压到最低：

```
Console UI: "Add Credential"
  │
  ├── OAuth App → 弹出授权页 → 用户点同意 → refresh token 存 Vault
  ├── Cookie Session → 弹出 Live View 浏览器 → 手动登录 → cookie 存 KV
  ├── API Key → 直接粘贴 → 存 Vault
  └── Username/Password → 填入 → 加密存 Vault
```

### OAuth Token 自动续期

后台服务（Durable Object Alarm）定期刷新，**Agent 不直接碰 token**：

```
┌─ Credential Lifecycle Manager（Durable Object）─┐
│                                                    │
│  Alarm 每 30 分钟触发：                              │
│    1. 从 Vault 读 refresh_token                    │
│    2. 检查 access_token 剩余寿命                    │
│       （< 25% 时触发刷新，如 Google 1h 的 token     │
│        在 45 分钟时就刷新）                          │
│    3. POST /oauth/token {                          │
│         grant_type: "refresh_token",               │
│         refresh_token: "xxx"                       │
│       }                                            │
│    4. 存新 access_token 到 Vault                   │
│    5. 如果 provider 返回新 refresh_token（rotation）│
│       → 立刻写回 Vault                              │
│    6. 如果 refresh_token 失效                       │
│       → 标记 credential 状态为 expired              │
│       → Console UI 显示红色告警                     │
│       → 用户重新授权                                │
│                                                    │
│  Agent 需要 token 时：                              │
│    → 调 get_credential tool                        │
│    → 直接从 Vault 取 access_token（已经是有效的）   │
│                                                    │
│  关键：单点刷新，避免多 agent 同时刷导致             │
│       race condition 或 token rotation 冲突         │
└────────────────────────────────────────────────────┘
```

### Cookie 持久化（无限续命）

**Agent 每次使用浏览器后回写最新 cookie，session 可以无限延长：**

```
操作前：KV 读 cookies → page.setCookie(...cookies)
操作中：网站可能更新 cookie（新 session ID, CSRF token 等）
操作后：page.cookies() → 写回 KV

→ 下次使用的是最新 cookie
→ 只要 agent 定期使用，session 不会过期
```

### Agent 侧 Tools

```
browser_open(url, credential_name?)
  → 从 KV 加载 cookie → 启动 Browser Rendering → 注入 cookie → 打开页面

browser_act(action)
  → Stagehand 自然语言操作 或 Playwright 精确操作

browser_screenshot()
  → 截图返回给 agent（用于视觉理解）

browser_extract(description)
  → AI 提取页面信息（结构化数据）

browser_close()
  → 导出 cookie 到 KV → 关闭浏览器

get_credential(name, type)
  → 从 Vault 取 access_token 或 cookie（后台已自动续过）

save_credential(name, type, value)
  → agent 手动存凭证（某些场景需要）
```

---

## 集成架构

```
┌─ SessionDO ──────────────────────────────────────────────────┐
│                                                                │
│  Agent Harness                                                 │
│    ├── 已有 tools：bash, read, write, glob, grep, web_fetch   │
│    │                                                           │
│    ├── browser_* tools（新增）                                 │
│    │     ├── browser_open    → Browser Rendering binding       │
│    │     ├── browser_act     → Stagehand / Playwright          │
│    │     ├── browser_screenshot → CDP Page.captureScreenshot   │
│    │     ├── browser_extract → Workers AI vision               │
│    │     └── browser_close   → cookie 回写 KV + 关闭          │
│    │                                                           │
│    └── credential tools（新增）                                │
│          ├── get_credential  → Vault/KV 读                    │
│          └── save_credential → Vault/KV 写                    │
│                                                                │
│  Screencast（可选，用户开启时）                                 │
│    └── CDP Page.startScreencast → WebSocket → Console UI      │
│                                                                │
│  Credential Lifecycle Manager（Durable Object）                │
│    └── Alarm 定期刷新 OAuth tokens                             │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

## 第三方备选方案

### Browserbase

- **官网**：https://www.browserbase.com/
- Browser-as-a-service，API 控制的 Chrome 实例
- **Live View**：内置实时画面 URL，一行代码嵌入 iframe
- **Context**：内置 cookie/session 持久化，无需自己实现
- **Stealth Mode**：反爬 + 代理
- **适用场景**：如果不想自建 cookie 持久化层，Browserbase 开箱即用

### browser-use

- **开源**：https://github.com/browser-use/browser-use（MIT）
- **云服务**：https://browser-use.com/
- 核心技术：抛弃 Playwright，直接用 CDP（自研 cdp-use 库）
- **Live View 实现**：`live_url = f'https://live.browser-use.com/?wss={quote(cdp_url)}'`
  - 就是前端直连 CDP WebSocket，源码在 `browser_use/skill_cli/daemon.py:306`
  - `live.browser-use.com` 是一个静态前端页面，无需后端服务
- 录像功能：CDP `Page.startScreencast` → imageio 编码 mp4（`recording_watchdog.py`）
- 云版本提供带 CAPTCHA 绕过的 stealth 浏览器

### Vercel Agent Browser

- **Repo**：https://github.com/vercel-labs/agent-browser（开源）
- **完整的 live view 实现**（Rust），源码在 `cli/src/native/stream/`：
  - `cdp_loop.rs` —— CDP screencast 帧接收 + 广播
  - `websocket.rs` —— WebSocket server，接受客户端连接
  - `mod.rs` —— StreamServer 框架，管理客户端计数、按需开关 screencast
- 支持双向交互（`Input.dispatch*`）
- **最适合作为我们实现的参考**

---

## 待解决的问题

- [ ] Browser Rendering 在大规模场景下的定价（per-session？per-minute？）
- [ ] Stagehand 与裸 Playwright 在 agent 可靠性上的对比
- [ ] Screencast 帧率和带宽优化（quality / maxWidth 参数调优）
- [ ] 多 agent 共享 browser instance 还是一 agent 一 browser
- [ ] Cookie 过期检测策略（主动检测 vs 使用时发现）
- [ ] Human-in-the-loop 时 agent/用户操作的冲突处理