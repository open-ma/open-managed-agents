# Agent IM: Inter-Agent Communication Design

> Design insights for building Slack-like inter-agent messaging on the Managed Agents platform, derived from analysis of Claude Code's Agent Teams architecture.

## Background

The platform currently supports **hierarchical** sub-agent communication via `callable_agents` (parent calls child, child returns result). This document outlines the design for **peer-to-peer** IM-like communication between agents, enabling multi-agent collaboration patterns similar to a team chat workspace.

**Reference implementation**: Claude Code Agent Teams (`~/.claude/teams/`, SendMessage tool, file-based mailbox, shared task list).

---

## Claude Code Agent Teams: How It Works

### Architecture

Claude Code implements an **actor model** where each agent is an isolated LLM conversation with its own mailbox:

```
~/.claude/teams/{team_name}/
├── config.json                 # Team config: name, members, lead
└── inboxes/
    ├── team-lead.json          # Leader's inbox
    ├── researcher.json         # Member inbox
    └── implementer.json        # Member inbox
```

Each inbox is a JSON array of messages:

```json
[
  {
    "from": "researcher",
    "text": "Analysis complete, found 3 issues",
    "timestamp": "2025-04-10T10:30:00Z",
    "read": false,
    "color": "blue",
    "summary": "analysis done"
  }
]
```

### Message Lifecycle

**Step 1 — Send**: Agent A calls `SendMessage({ to: "agent-b", message: "hello" })`.

**Step 2 — Route**: The tool writes to agent-b's inbox file with file-level locking (proper-lockfile, exponential backoff, 10 retries).

**Step 3 — Poll**: Agent B's main loop polls its inbox file, consuming messages with priority ordering:
1. `shutdown_request` (highest)
2. Messages from team-lead
3. Messages from any peer
4. Unclaimed tasks from shared task list

**Step 4 — Inject into LLM**: The message is wrapped in XML and injected as a user message:

```xml
<teammate-message teammate_id="researcher" color="blue" summary="analysis done">
Analysis complete, found 3 issues:
1. SQL injection at user.ts:42
2. XSS at render.ts:88
3. Hardcoded key at config.ts:15
</teammate-message>
```

**Step 5 — Idle notification**: After processing, agent B sends a structured notification to the leader's inbox:

```json
{
  "type": "idle_notification",
  "from": "agent-b",
  "idleReason": "available",
  "summary": "[to agent-a] I'll fix those issues",
  "completedTaskId": "3",
  "completedStatus": "resolved"
}
```

### Message Consumption: Priority and Timing

When an agent reaches its idle state, it polls for messages every 500ms with strict priority ordering:

```
Priority 1 (highest): shutdown_request
    → Scanned first, skips all other messages
Priority 2: Messages from team-lead
    → Leader's instructions take precedence over peer chatter
Priority 3: Messages from any peer (FIFO)
    → First unread message from any teammate
Priority 4 (lowest): Unclaimed tasks in shared task list
    → Auto-claim if no messages pending
```

This prevents peer-to-peer chatter from starving leadership directives — a critical design decision for coordinated multi-agent workflows.

### User Interaction Paths

CC supports three ways for a human user to interact with teammates:

1. **Through the Leader**: User types normally → Leader processes → Leader calls SendMessage to teammates. This is the primary path.

2. **Transcript view**: User switches to viewing a teammate's transcript, types directly. Message goes to `pendingUserMessages` (in-memory queue), consumed when teammate is idle.

3. **@name syntax**: User types `@researcher analyze this bug` at the leader prompt. Message is written directly to researcher's file inbox, bypassing the leader's LLM entirely.

All three paths deliver messages only when the target teammate is idle (between turns). The leader is the only agent that receives user input in real-time.

### Key Design Decisions in CC

- **Tools are the only communication channel**: Text output is invisible to peers. Agents must explicitly call `SendMessage`. This makes communication controllable, auditable, and routable.

- **System prompt injection**: Every teammate's system prompt is appended with instructions explaining they're in a team and must use `SendMessage` to communicate.

- **Shared task list**: `TaskCreate`, `TaskList`, `TaskUpdate`, `TaskGet` tools operate on a shared directory (`~/.claude/tasks/{team_name}/`), providing durable coordination alongside ephemeral messaging.

- **Flat team structure**: One leader + N members. No nested teams, no channels.

- **No mid-turn steering**: Agents process one message per turn completely before receiving the next. This simplifies concurrency and prevents context corruption.

### Mid-Turn Steering: What Can and Cannot Happen

A critical aspect of CC's architecture is **the absence of mid-turn steering**. Once an agent enters a turn (`runAgent()` executing), it cannot receive or process new messages until the turn completes.

#### CC's Two Abort Controllers

Each teammate has two independent abort mechanisms:

```
workAbortController     — stops current turn, agent stays alive → idle
                          triggered by: user presses Escape
lifecycleAbortController — kills entire teammate
                          triggered by: shutdown approval
```

These are checked at every step inside `runAgent()`:

```typescript
for await (const message of runAgent({ ... })) {
  if (abortController.signal.aborted) break        // kill teammate
  if (workAbortController.signal.aborted) break     // stop this turn
  // ... normal processing ...
}
```

**But abort is not steer** — after abort, the agent goes back to idle and waits for the next message. It doesn't receive a replacement instruction mid-turn.

#### What Happens When Messages Arrive Mid-Turn

```
                            Agent is RUNNING          Agent is IDLE
                            ──────────────           ─────────────
Agent→Agent (SendMessage)   Written to file inbox,   Polled every 500ms,
                            waits until idle         consumed immediately

User→Teammate (transcript)  Queued in memory         Polled every 500ms,
                            (pendingUserMessages),   consumed immediately
                            waits until idle

User→Teammate (@name)       Written to file inbox,   Polled every 500ms,
                            waits until idle         consumed immediately

User→Leader                 DIRECT — user input      DIRECT — starts
                            triggers Escape/abort    new turn immediately
```

**Only the Leader (main CLI agent) can be steered in real-time by the user.** All teammates are "deaf" during a turn.

#### Why It Feels Instant Despite No Mid-Turn Steering

Three factors create the illusion of real-time communication:

1. **UI feedback is immediate**: `injectUserMessageToTeammate()` adds the message to `task.messages` for display at the same time it queues for delivery. The user sees the message appear instantly in the transcript.

2. **Turns are usually short**: Most agent turns complete in seconds, so the delay between "message queued" and "message consumed" is barely noticeable.

3. **Leader acts as fast relay**: User → Leader (instant) → SendMessage to Teammate (queued) → Teammate picks up on next idle cycle (fast).

#### Implications for Our Platform

For V1, we adopt the same model: **no mid-turn steering**. Messages are delivered via DO→DO push but consumed only between turns.

Potential V2 enhancements:

| Strategy | Description | Complexity |
|----------|-------------|------------|
| **check_messages tool** | Agent can voluntarily check inbox mid-turn | Medium |
| **Urgent message interrupt** | High-priority messages abort current turn, re-inject context | High |
| **Streaming injection** | Append to system prompt dynamically during generation | Very high |

---

## Design Principles for Our Platform

Three core principles extracted from CC's approach:

### Principle 1: Messages Are LLM Input, Not Human Chat

The message format, metadata, and injection timing must be designed to help the **model** understand and act correctly. The human-facing UI is a separate presentation layer.

CC wraps messages in `<teammate-message>` XML tags with sender ID, color, and summary attributes. The model parses this to understand who sent what and decide its next action.

**Implication for us**: Store messages in structured format (TeamDO SQLite), but convert to XML/tagged format when injecting into LLM context. Include rich metadata (sender role, timestamp, summary, related task ID) so the model can make priority judgments.

### Principle 2: Tool-Mediated Communication Only

Agent text output (`agent.message` events) is visible only to the client, never to peer agents. All inter-agent communication must flow through the `send_message` tool.

This constraint is enforced by the system prompt, not by code. Without explicit instructions, LLMs will try to "talk" to peers through their text output.

**Implication for us**: When a session joins a team, append to its system prompt:

```
# Team Context
You are "{member_name}" in team "{team_name}".
Team members: planner (lead), coder, tester.
Use send_message to communicate. Your text output is NOT visible to peers.
Use task_create/task_update to coordinate shared work.
```

### Principle 3: Actor Model — Isolation + Async Mailbox + Event-Driven State Sync

Each agent runs independently with no shared context window. Coordination happens through:
- **Async messages** for ephemeral communication
- **Idle notifications** for state synchronization
- **Shared task list** for durable coordination

This is a proven distributed systems pattern. CC validated it for the AI agent use case.

---

## CC's Limitations and Our Improvements

| CC Limitation | Root Cause | Our Improvement |
|---------------|-----------|-----------------|
| File polling, 100ms+ latency | Local FS has no reliable watch | TeamDO → SessionDO HTTP push, sub-millisecond |
| Messages destroyed on exit | Temp files in `~/.claude/` | SQLite persistence, permanent audit trail |
| Single user | CLI tool | REST API, multi-user/multi-system |
| Flat structure, no channels | Designed for simplicity | Extensible to channels/topics |
| No message search | File storage | SQLite full-text search |
| Short-lived teams | CLI session lifecycle | Teams persist, members join/leave dynamically |
| No external integration | Local tool | API accepts webhooks, CI/CD, scheduled triggers |

---

## Architecture: Adapting CC to Cloudflare

### Infrastructure Mapping

```
CC (local filesystem)          →  Our Platform (Cloudflare)
─────────────────────────────────────────────────────────
Team config JSON file          →  TeamDO (Durable Object + SQLite)
Inbox JSON files               →  TeamDO messages table
Task JSON files                →  TeamDO tasks table
AsyncLocalStorage isolation    →  SessionDO isolation (one per agent)
File polling                   →  HTTP push (TeamDO → SessionDO)
Terminal UI (React Ink)        →  WebSocket/SSE → Console UI
```

### Component Overview

```
┌────────────────────────────────────────────────────┐
│ REST API   (src/routes/teams.ts)                   │
│ /v1/teams, /v1/teams/:id/members,                  │
│ /v1/teams/:id/messages, /v1/teams/:id/tasks        │
├────────────────────────────────────────────────────┤
│ TeamDO     (src/runtime/team-do.ts)                │
│ SQLite: members, messages, tasks                   │
│ Routes messages: TeamDO → target SessionDO         │
├────────────────────────────────────────────────────┤
│ Agent Tools (src/harness/team-tools.ts)            │
│ send_message, check_messages                       │
│ task_create, task_list, task_update, task_get       │
├────────────────────────────────────────────────────┤
│ Session Integration (session-do.ts)                │
│ POST /team-message endpoint                        │
│ Auto-inject unread messages into agent context     │
│ Team tools added when session is a team member     │
└────────────────────────────────────────────────────┘
```

### TeamDO Schema

```sql
CREATE TABLE team_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE members (
  name       TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  role       TEXT DEFAULT 'member',  -- 'lead' | 'member'
  status     TEXT DEFAULT 'idle',    -- 'idle' | 'active' | 'offline'
  joined_at  TEXT NOT NULL
);

CREATE TABLE messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_name  TEXT NOT NULL,
  to_name    TEXT,                   -- NULL = broadcast
  content    TEXT NOT NULL,
  summary    TEXT,
  read       INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subject     TEXT NOT NULL,
  description TEXT,
  status      TEXT DEFAULT 'pending', -- pending | in_progress | completed
  owner       TEXT,                   -- member name
  blocks      TEXT DEFAULT '[]',      -- JSON array of task IDs
  blocked_by  TEXT DEFAULT '[]',      -- JSON array of task IDs
  metadata    TEXT DEFAULT '{}',
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT
);
```

### Message Flow

```
Agent A (SessionDO-A)         TeamDO              Agent B (SessionDO-B)
    │                           │                        │
    │ send_message(to:"B",      │                        │
    │   message:"hello")        │                        │
    │──────POST /messages──────>│                        │
    │                           │ INSERT into messages   │
    │                           │ lookup B's session_id  │
    │                           │                        │
    │                           │──POST /team-message───>│
    │                           │                        │ append to event log
    │                           │                        │ broadcast via WebSocket
    │                           │                        │
    │                           │                        │ if idle → auto-trigger
    │                           │                        │   harness run
    │                           │                        │ if running → queue for
    │                           │                        │   next turn injection
    │                           │                        │
    │<──────"sent OK"───────────│                        │
```

### Idle Notification Flow

```
Agent B finishes processing
    │
    │ session status → idle
    │
    │──POST /status {"status":"idle"}──> TeamDO
    │                                      │
    │                          Update members.status = 'idle'
    │                                      │
    │                          POST /team-message ──> Leader's SessionDO
    │                          { type: "idle_notification",
    │                            from: "agent-b",
    │                            idleReason: "available",
    │                            completedTaskId: "3" }
```

### Context Injection

When a session that belongs to a team starts processing a turn:

1. Fetch unread messages from TeamDO (`GET /messages/{member_name}`)
2. Format as XML tags and prepend to conversation:

```xml
<team-messages team="{team_name}" member="{member_name}">
  <message from="planner" time="10:30:00" summary="task assignment">
    Please implement the /api/users CRUD endpoints.
  </message>
  <message from="tester" time="10:35:00" summary="test ready">
    Integration test suite is ready for your endpoints.
  </message>
</team-messages>
```

3. Mark messages as read in TeamDO
4. Append team context to system prompt (member list, role info)
5. Inject team tools (`send_message`, `task_*`) into agent tool set

---

## Agent Tools Specification

### send_message

```typescript
{
  name: "send_message",
  description: "Send a message to a team member or broadcast to all.",
  parameters: {
    to:      { type: "string", description: 'Recipient name, or "*" for broadcast' },
    message: { type: "string", description: "Message content" },
    summary: { type: "string", description: "5-10 word preview", optional: true },
  }
}
```

### check_messages

```typescript
{
  name: "check_messages",
  description: "Check for unread messages from team members.",
  parameters: {}
}
```

### task_create

```typescript
{
  name: "task_create",
  description: "Create a shared task in the team task list.",
  parameters: {
    subject:     { type: "string" },
    description: { type: "string" },
    owner:       { type: "string", optional: true },
  }
}
```

### task_list

```typescript
{
  name: "task_list",
  description: "List all tasks in the team task list.",
  parameters: {}
}
```

### task_get

```typescript
{
  name: "task_get",
  description: "Get full details of a task.",
  parameters: {
    task_id: { type: "string" }
  }
}
```

### task_update

```typescript
{
  name: "task_update",
  description: "Update a task's status, owner, or dependencies.",
  parameters: {
    task_id:      { type: "string" },
    status:       { type: "string", enum: ["pending", "in_progress", "completed"], optional: true },
    owner:        { type: "string", optional: true },
    add_blocks:    { type: "array", items: "string", optional: true },
    add_blocked_by: { type: "array", items: "string", optional: true },
  }
}
```

---

## New Event Types

```typescript
// Team messaging
"team.message_sent"       // Agent sent a peer message
"team.message_received"   // Agent received a peer message

// Team membership
"team.member_joined"      // Session joined a team
"team.member_left"        // Session left a team
"team.member_idle"        // Member became idle (status sync)

// Team tasks
"team.task_created"       // Task created in shared list
"team.task_updated"       // Task status/owner changed
```

All events are persisted in both TeamDO and each session's event log, enabling full observability.

---

## API Endpoints

```
POST   /v1/teams                       Create team
GET    /v1/teams                       List teams
GET    /v1/teams/:id                   Get team (members, status)
DELETE /v1/teams/:id                   Dissolve team

POST   /v1/teams/:id/members           Add member (bind session)
DELETE /v1/teams/:id/members/:name     Remove member
GET    /v1/teams/:id/members           List members with status

POST   /v1/teams/:id/messages          Send message (external/API)
GET    /v1/teams/:id/messages          Message history

GET    /v1/teams/:id/tasks             List tasks
POST   /v1/teams/:id/tasks             Create task (external)
PUT    /v1/teams/:id/tasks/:task_id    Update task (external)
```

---

## Summary: CC Teams vs Our Agent IM

| Dimension | CC Agent Teams | Our Agent IM |
|-----------|---------------|--------------|
| Runtime | Local terminal (single machine) | Cloudflare cloud (distributed) |
| Message store | Filesystem JSON | TeamDO SQLite |
| Message routing | File read/write + polling | TeamDO → SessionDO HTTP push |
| Realtime | Polling (latency) | WebSocket push to clients |
| Observability | Terminal UI (React Ink) | Web Console + SSE event stream |
| Team creation | Agent via TeamCreate tool | REST API + agent tools |
| Agent isolation | Process-level (AsyncLocalStorage / tmux) | Session-level (each SessionDO independent) |
| Task list | Filesystem JSON | TeamDO SQLite |
| Lifecycle | Destroyed on CLI exit | Persistent, survives restarts |
| Multi-user | Single user | Multi-user via API |
| External integration | None | API accepts webhooks, CI/CD |

**One-line summary**: CC Teams is "local multi-terminal"; our Agent IM is "cloud-native agent chat workspace".

---

## Vision: Human-Agent Collaboration

Beyond the IM implementation details, there are two fundamental properties of agents that reshape how collaboration should work — and they directly influence the platform's long-term architecture.

### Tools as Identity

In a human team, a person's role is defined by their skills (frontend engineer, DBA, SRE). An agent's role is defined by its **tool configuration**:

```
Agent Config = Model + System Prompt + Skills + MCP Servers + CLI tools
             = a complete "job role" definition
```

Example configurations:

```
┌─ Agent Config "db-admin" ─────────────────────┐
│ Skills:  sql-optimizer, migration-planner      │
│ MCP:     postgres-mcp, redis-mcp              │
│ CLI:     psql, pg_dump, redis-cli             │
│ Model:   claude-sonnet (sufficient, cheap)    │
└───────────────────────────────────────────────┘

┌─ Agent Config "security-reviewer" ────────────┐
│ Skills:  code-audit, cve-scanner              │
│ MCP:     github-mcp, snyk-mcp                │
│ CLI:     semgrep, trivy, git                  │
│ Model:   claude-opus (deep reasoning needed)  │
└───────────────────────────────────────────────┘
```

Creating an agent is not "hiring a person" — it's **instantiating a job role**. The agent config is a reusable template; the session is a running instance.

This has a direct impact on message routing. Beyond routing by name, we can route by **capability**:

```
// Route by name (current, CC-style)
send_message({ to: "db-admin-1", message: "check slow queries" })

// Route by capability (future)
send_message({ to: { capability: "sql-optimizer" }, message: "check slow queries" })
// TeamDO finds an available agent with this skill and routes automatically
```

This turns the team into a **service mesh** — messages are routed to "whoever can handle this", not to a specific individual.

### Infinite Scale

Human teams have hard constraints: hiring takes months, people work 8 hours/day, and teams larger than 7-8 members hit Brooks's Law communication overhead.

Agents have none of these constraints:

```
Need 10 coders in parallel?    → Instantiate 10 sessions from the same agent config
3 AM production alert?         → Agents are online 24/7
Task done, don't need them?    → Destroy session, zero ongoing cost
Need different expertise?      → Swap tool config, instant role change
```

This fundamentally changes team topology:

#### Dynamic Composition: Teams as Verbs, Not Nouns

CC's teams are static — members are fixed at creation time. With infinite scale, teams should be **dynamic**:

```
User: "Refactor the payment module"
         │
         ▼
  Planner agent analyzes the task
         │
         ▼
  ┌── Determines required capabilities ──┐
  │                                      │
  ▼                                      ▼
Need 3 coders                      Need 1 DBA
(3 files to change in parallel)    (schema migration)
  │                                      │
  ▼                                      ▼
Instantiate 3 sessions             Instantiate 1 session
from "coder" config                from "db-admin" config
  │                                      │
  ▼                                      ▼
Work in parallel                   Work
  │                                      │
  ▼                                      ▼
Done → destroy sessions            Done → destroy session
```

A team is not a fixed group of members — it's a **temporary formation assembled for a specific mission**.

#### Fan-Out: Horizontal Task Splitting

Something human teams cannot do — split one task across N identical agents:

```
Task: "Write tests for 200 API endpoints"

Human team:  1 tester × 200 endpoints = weeks

Agent team:
  ┌→ tester-1:  endpoints 1-20    → done, destroy
  ├→ tester-2:  endpoints 21-40   → done, destroy
  ├→ tester-3:  endpoints 41-60   → done, destroy
  │  ...
  └→ tester-10: endpoints 181-200 → done, destroy

  10 agents × 20 endpoints each = hours
```

For the IM system, this means messages can be sent not just to an agent, but to an **agent pool** — the system load-balances across available instances:

```
send_message({
  to: { agent_config: "tester", pool: true },
  message: "test endpoints 41-60"
})
// TeamDO routes to an idle tester instance, or spins up a new one
```

#### Recursive Hierarchy: Any Agent Can Be a Leader

Any agent can spawn sub-agents, creating recursive team structures:

```
Human
  └→ Planner (leader)
       ├→ Frontend Lead (sub-leader)
       │    ├→ coder-1
       │    ├→ coder-2
       │    └→ coder-3
       ├→ Backend Lead (sub-leader)
       │    ├→ coder-4
       │    ├→ coder-5
       │    └→ db-admin
       └→ QA Lead (sub-leader)
            ├→ tester-1
            ├→ tester-2
            └→ tester-3
```

The platform already supports hierarchical delegation via `callable_agents`. Combined with team IM, this enables recursive composition — a team within a team.

### The Abstraction Stack

Tools + Scale together produce a layered abstraction:

```
Agent Config (job role template)
    = Model + Prompt + Skills + MCP + CLI tools
    ↓
Agent Instance (running worker)  × N
    = Agent Config + Session + Sandbox
    ↓
Team (dynamic formation)
    = {Agent Instances} + Task List + Message Bus
    ↓
Workspace (collaboration space)
    = {Teams} + Shared Memory + Shared Artifacts + Human Members
```

### Mixed-Initiative Collaboration

The end state is not "human commands agents" or "agents work autonomously." It's **mixed-initiative** — both humans and agents can initiate, respond, and escalate:

| Mode | Initiator | Example | Latency Tolerance |
|------|-----------|---------|-------------------|
| **Command** | Human → Agent | "Build feature X" | Low |
| **Consult** | Agent → Human | "Should I use async or sync for this?" | Medium (human may be busy) |
| **Notify** | Agent → Human | "Task #3 complete, PR ready" | High (async notification) |
| **Coordinate** | Agent → Agent | "I finished the API, please write tests" | Low |
| **Escalate** | Agent → Human | "I've failed 3 times, need help" | Medium |

A concrete scenario:

```
09:00  Human posts in workspace:
       "Ship user management API this week"

09:01  Planner agent responds:
       → Creates 5 tasks, assigns to coder and tester agents

09:15  Coder agent → Human (consult):
       "Support soft-delete? It affects the schema design."

09:20  Human: "Yes, use deleted_at column"

09:21  Coder continues autonomously

10:30  Coder → Tester (coordinate):
       "GET/POST /users ready, please test"

10:35  Tester → Coder (coordinate):
       "POST /users missing email validation, test failed"

10:36  Coder auto-fixes, notifies tester again

10:40  Tester → workspace (notify, broadcast):
       "All tests passing ✓"

       ... human goes to a meeting, agents continue ...

12:00  Human returns, sees workspace status:
       3/5 tasks done, 1 blocked (needs approval), 1 in progress

12:01  Human approves blocked task, work continues
```

The human made **3 interventions** (goal, decision, approval). Agents handled everything else — planning, coding, testing, coordination, error recovery.

### Platform Implications

| Capability | Current State | Evolution Needed |
|------------|--------------|------------------|
| Team members | Static session binding | Dynamic: instantiate from agent config on demand |
| Message routing | By member name | By name + by capability + by pool |
| Fan-out | Not supported | `send_message` to agent pool, auto-distribute |
| Instance lifecycle | Manual create/destroy | Auto-create on task assignment, auto-destroy on completion |
| Team structure | Flat | Recursive: sub-teams, agent-as-leader |
| Human participation | External (API caller) | Internal (workspace member with consult/notify flows) |
| Autonomy level | Uniform per agent | Per-task: low (approval gates) → high (fire-and-forget) |

### Core Architecture: Task Triggering + Event Log

The fundamental insight from analyzing CC's architecture, existing products like Slock.ai, and various UI paradigms (Slack-style chat, spatial canvas, pipeline view, decision inbox) is that the **backend protocol and the presentation layer are completely separate concerns**:

```
Settled (build this):
  Task triggering + Event log = backend coordination protocol
  TeamDO, send_message, shared tasks, event stream

Open (explore later):
  Presentation layer = how humans see and interact with it
  Chat view / Canvas view / Decision inbox / Pipeline view / all of the above
```

The backend does two things:

1. **Task triggering**: Agents send messages and create/update tasks. Messages trigger other agents to wake up and act. Tasks track shared state and dependencies. This is the coordination protocol — it works regardless of whether any human is watching.

2. **Event log**: Every message, task change, and agent state transition is persisted as a typed event in the session and team event logs. Events are the source of truth. Any presentation layer is just a view over this event stream.

This separation means:
- The same event stream can power a chat UI, a canvas, a dashboard, or a CLI — simultaneously
- The backend can be built and validated independently of any UI decision
- Agents don't care how humans consume the events; they communicate through tools and tasks
- New presentation paradigms can be explored without touching the coordination layer

The interaction model between humans and agents is **agent-driven, human-supervisory**: agents do the work and self-coordinate; humans set goals, make decisions when consulted, and approve when asked. The presentation layer should optimize for this — minimizing the time humans spend in the UI, not maximizing it.

### Design Guideline

> **Agent IM is not chat software for AI. It's the coordination layer of a workspace where humans set direction, agents execute and self-organize, and the system scales by instantiating capabilities — not by adding headcount.**

---

## Multica Comparison: What We Already Solve, What We Actually Lack

> Added 2026-04-12, after deep analysis of [multica](https://github.com/anthropics/multica) — an open-source managed agents platform with local daemon execution.

### Our Architecture Advantages Over Multica

| Concern | Multica's Approach | Our Approach | Why Ours Is Better |
|---|---|---|---|
| **Work context** | `PriorSessionID` + `PriorWorkDir` — store last session/workdir per (agent, issue), resume via CLI `--resume` flag | SessionDO event log — all history persisted in DO SQLite, harness auto-rebuilds from event log | Multica's is a hack: CLI process dies, state is gone, only the session ID lets you "resume". Our event log IS the state — crash recovery is free. |
| **Agent identity** | Separate `agent` table + `agent_runtime` table + `agent_task_queue` — agent is a DB row, runtime is a separate concept | Session = agent instance. Agent config creates session, session IS the persistent running agent. | No impedance mismatch. Multica needs 3 tables to express what we do with one DO. |
| **Task routing** | `ClaimTask` — daemon polls for tasks, atomically claims one. Runtime sweeper detects stale claims. | TeamDO → SessionDO HTTP push. Message delivered directly to target session. | Pull vs push. Multica's daemon must poll every 3 seconds. Our messages arrive instantly. |
| **Coordination** | Flat: user assigns issue → one agent executes. No agent-to-agent communication. | Actor model: agents send messages, create shared tasks, self-organize. | Multica agents are isolated workers. Ours are collaborating teammates. |

### What We Actually Lack (vs Multica)

After removing false gaps (work context, persistent identity, cost attribution — all already solved by SessionDO), the real differences are:

#### 1. External Trigger Mechanism

**Multica has**: Issue assignment → task. @mention → task. Chat message → task. Three natural entry points.

**We lack**: A way for external events (GitHub webhook, Slack message, cron) to automatically create a team task and wake an agent. The TeamDO API endpoints are defined but the "event → task" bridge isn't designed.

**Solution sketch**: A trigger system — webhook endpoint that maps external events to `send_message` or `task_create` calls on a TeamDO. Could be a simple Worker route.

#### 2. Local Agent Execution

**Multica has**: Full daemon — polls server, executes agent CLIs locally, streams output back, session resumption, repo caching. Code never leaves the developer's machine.

**We lack**: Any local execution path. Everything runs in Cloudflare Containers.

**Solution sketch**: A lightweight local daemon (Node.js or Go) that polls our API, runs agent CLIs locally, reports via existing session event API. Mirror multica's daemon architecture but connect to our API instead of theirs.

#### 3. Failure Recovery Strategy

**Multica's approach**: Runtime sweeper every 30s — mark offline runtimes, auto-fail orphaned tasks. This is "give up and let humans retry."

**Our advantage**: SessionDO's event log means we can do better than "fail":

```
Agent times out or crashes
  │
  ├─ Option 1: Restart harness
  │  SessionDO re-reads event log → rebuilds context → continues
  │  (already supported: harness crash recovery)
  │
  ├─ Option 2: Escalate model
  │  Same session, switch to stronger model (model card system)
  │  Agent sees prior work in history, retries with more capability
  │
  ├─ Option 3: Decompose
  │  Agent reviews event log, splits remaining work into sub-tasks
  │  Sends via TeamDO to other agents
  │
  └─ Option 4: Escalate to human
  │  Send notification (the "escalate" mode from Mixed-Initiative)
  │
  Key insight: event log preserves ALL prior work.
  "Resume from where you failed" is free.
  Multica can't do this — CLI process death = state loss.
```

**What to implement**: A recovery policy in SessionDO — configurable per agent. Default: restart harness up to 3 times, then escalate. Not a sweeper, because DOs don't "silently die" like external daemons.

### Summary

The gap between our design and multica is **much smaller than it appears**. Most of multica's complexity (runtime registration, heartbeat, sweeper, session resumption, workdir persistence) exists to compensate for architectural limitations of the daemon model. Our SessionDO eliminates the need for most of it.

The three real gaps (external triggers, local agent, failure recovery) are all additive features, not architectural rework. The coordination layer (TeamDO + agent tools + message routing) is the core, and it's already fully designed.
