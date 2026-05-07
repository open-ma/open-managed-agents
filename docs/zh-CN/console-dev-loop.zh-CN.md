# Console 开发循环调试 Playbook

记录在本项目调试 console + integrations UI 时遇到的实战经验。每一条都是真实卡过我半小时以上的坑，以及最终破局的动作——不是泛泛的「打开 DevTools 看看」清单。把它们写下来，是为了让未来的你少踩一次同样的坑。

## Vite 在 pnpm workspace 跨包时 watcher 静默失效

**症状**：你改了 `packages/integrations-ui/src/pages/Foo.tsx`，磁盘上文件确实是新的，`curl http://localhost:5174/@fs/.../Foo.tsx?t=$(date +%s)` 返回的也是**新代码**，但去掉 `?t=...` 这个 cache-buster 的 `curl` 却返回**旧代码**，浏览器无论 `Page.reload` 多少次还是渲染旧 UI。`tail -f vite.log` 在你 `touch` 文件时根本没出 `[vite] hmr` 事件。

**原因**：Vite 的 per-URL transform 缓存只在 watcher 收到事件时失效。当源文件位于「dev server 启动包之外」（比如 console 是从 `apps/console` 启动的，但文件在 `packages/integrations-ui`），文件 watcher 可能根本没注册到那条路径上。在 macOS 上用 chokidar / fsevents 时通常都是静默失败。

**修复**：

```bash
# 杀掉正在跑的 vite，清掉 optimizer 缓存，加 --force 重启
pkill -f 'apps/console.*vite'
rm -rf apps/console/node_modules/.vite/
cd apps/console && npx vite --force
```

仅靠浏览器硬刷新**不会**解决——dev server 仍然在吐它缓存的 transform。修完后用 cache-buster curl 验证：现在带不带 `?t=` 应当返回同样的代码。

## CDP 注入 session cookie（当你登不进表单的时候）

**症状**：你需要在真实浏览器里测试一个需要登录的 Console 页面，但你不知道测试用户的密码；或者你不小心从 CDP 跑了 `Network.clearBrowserCookies` 把自己注销了。

**不要**去试密码表单（除非你真的知道密码）。**请用** email-OTP 后门铸一个新的 session（开发环境可以这么干，因为 OTP 直接存在本地 D1 的 verification 表里）：

```bash
# 1. 触发一次 OTP
curl -X POST http://localhost:5174/auth/email-otp/send-verification-otp \
  -H "Content-Type: application/json" \
  -d '{"email":"claude-test@example.com","type":"sign-in"}'

# 2. 从 D1 里把 OTP 捞出来
cd apps/main && npx wrangler d1 execute openma-auth --local --command \
  "SELECT value FROM verification WHERE identifier = 'sign-in-otp-claude-test@example.com' ORDER BY expiresAt DESC LIMIT 1"
# value 形如 "<code>:0"

# 3. 用 OTP 换 session，把 cookie 抓下来
curl -c /tmp/cookies.txt -X POST http://localhost:5174/auth/sign-in/email-otp \
  -H "Content-Type: application/json" \
  -d '{"email":"claude-test@example.com","otp":"123456"}'

# 4. 通过 CDP 把 cookie 注入到真实浏览器的 tab 里
grep better-auth.session_token /tmp/cookies.txt
# 把 value 原封不动（包含 URL-encode）传给 Network.setCookie
```

注意：cookie 值里包含 `%2F` / `%2B` / `%3D`（URL-encode 后的 `/` / `+` / `=`）。better-auth 期望的就是这种形式——直接原样传给 `Network.setCookie`，**不要**先 decode。

dev 环境下 session 较短（约 7 天，但 harness session 更短）；如果调试中途过期，重复上面的步骤。**别把 cookie 写死在脚本里。**

## 锁定到正确的 Chrome tab

`agent-browser connect 9333` 抓的是 `/json/list` 顺序里的第一个 tab，**未必是你想要的那个**——尤其是当你同一浏览器里同时开着 staging 和 local dev 两个 tab。务必先消歧：

```bash
# 列出所有命中 localhost 的 tab
curl -s http://localhost:9333/json/list | python3 -c "
import sys, json
print(json.dumps([
  {'id': t['id'], 'url': t['url'], 'title': t['title']}
  for t in json.load(sys.stdin)
  if t.get('type') == 'page' and 'localhost' in t.get('url', '')
], indent=2))"
```

然后通过那个 tab 自己的 `webSocketDebuggerUrl` 驱动它。这种场景下用 `ws` 包写一段小 Node 脚本比 `agent-browser` 更稳——`agent-browser` 每次调用都会重解析「current tab」，多 tab 时容易飘。

### 当 agent-browser 总是飘——直接走 CDP

一个子 agent 曾烧掉 55 次工具调用尝试让 `agent-browser` 在多 tab 的 Chrome 里聚焦到指定 Linear tab，下面这些招都没稳定生效过：

- `agent-browser connect 9333`（落在 Chrome 自认的「第一个」tab 上）
- `curl -X POST .../json/activate/<id>` 然后重连（被激活的 tab 进了前台，但 agent-browser 仍然绑在过期的 target 上）
- `agent-browser close && agent-browser connect 9333`（重新绑到一个随机 tab）
- `agent-browser connect ws://localhost:9333/devtools/page/<id>`（静默绑了，但 `get url` 还是返回错的 tab）

根因：`agent-browser` 缓存了一个 target 引用，而 CDP 里的「current target」并不真的是 per-connection 概念。单 tab 时一切正常；多 tab 时你只能直接驱 CDP。模板如下：

```javascript
// /tmp/cdp-drive.mjs
import WebSocket from 'ws';
const tabs = await fetch('http://localhost:9333/json/list').then(r => r.json());
const tab = tabs.find(t => t.url?.includes('linear.app/<workspace>/settings/api'));
if (!tab) { console.log('tab not found'); process.exit(1); }
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let id = 0;
const send = (method, params) => new Promise((resolve, reject) => {
  const msgId = ++id;
  ws.send(JSON.stringify({ id: msgId, method, params }));
  ws.on('message', function handler(data) {
    const msg = JSON.parse(data);
    if (msg.id === msgId) {
      ws.off('message', handler);
      msg.error ? reject(msg.error) : resolve(msg.result);
    }
  });
});
ws.on('open', async () => {
  await send('Runtime.enable');
  // 任意操作：点击、输入、抓数据
  const r = await send('Runtime.evaluate', {
    expression: "document.querySelector('input[name=\"name\"]').value = 'LinearBot'; 'ok'",
    returnByValue: true,
  });
  console.log(r.result.value);
  ws.close();
  process.exit(0);
});
```

第一次安装：`cd /tmp && npm install ws --silent`。

代码冗长但稳定。诀窍是：**绑到 tab 自己的 `webSocketDebuggerUrl`，永远不要绑通用的 `:9333` 连接。**绑定在 WebSocket 生命周期内是稳的。

## 「Vite 已发新代码，浏览器还是旧的」

两类完全不同的故障表现一样。先诊断、再下手：

```bash
# A：dev server 是否在转译新代码？
curl -s "http://localhost:5174/path/to/Foo.tsx?t=$(date +%s)" | grep -c NEW_STRING

# B：浏览器是否拉到了新代码？
agent-browser eval "fetch('/path/to/Foo.tsx', {cache:'no-store'}).then(r=>r.text()).then(t=>t.includes('NEW_STRING'))"
```

- A=0、B=任意 → 文件没保存，或者你改错文件了。`ls -la` 一下磁盘上的路径。
- A>0、B=false → 浏览器内存缓存。通过 CDP 用 `Page.reload` 加 `ignoreCache: true`，或者关掉重开 tab。
- 加了 cache-buster 还是 A=0 → Vite transform 缓存卡死。重启 vite（参见上面「Vite watcher 静默失效」一节）。
- A>0、B=true，但页面仍然是旧的 → React 模块图没有重新 import。需要做一次完整的 document 跳转（`Page.navigate` 到别的 URL 再回来），而不是 React Router 的 pushState。

## 廉价地观察活的 React DOM

不需要截图时别截图。文本观察更快，还能 grep：

```bash
agent-browser eval "document.body.innerText"            # 整页文本
agent-browser eval "document.title + ' / ' + location.href"
agent-browser eval "document.querySelector('h1')?.textContent"
```

只有真的需要*看*布局 / 颜色 / 间距时才截图——截图慢、渲染慢、还会烧 context。一段 100 字符的 `document.body.innerText` 通常就能回答「我的改动落地了吗？」

## 内层滚动容器把内容藏起来时

如果 `agent-browser screenshot --full` 出来的图明显比页面短，说明页面里有个内层 `overflow: auto` 容器（常见模式：`<div className="flex-1 overflow-y-auto">`）。full-page 截图截的是*外层* document，不是内层 scroller。两种处理方式：

- 截图前把对应容器滚到位：`document.querySelector('.flex-1.overflow-y-auto').scrollTop = 800`，再截。
- 或者用 `el.scrollIntoView({block: 'start'})` 直接跳到你想看的那一块。

## 把吵闹的细节存起来

任何花了 > 5 分钟才搞清楚的事都该写到这里。三个月后被同样的症状卡住的「未来的你」根本不会记得当初的 fix——他/她只会感到同样的恐惧。