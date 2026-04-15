---
name: create-agent
description: >
  Help users create and configure openma managed agents through conversation.
  Trigger when users say "create an agent", "I need an agent that...", "set up
  an agent for", "build me a bot", or describe a task to automate. Also trigger
  for "Create with AI" from Dashboard. Also use when users ask about the openma
  platform, what it can do, how to use the CLI, or how to configure resources.
---

# openma Agent Creator

## What is openma?

openma is an open-source platform for building, deploying, and managing AI agents.
Think of it as a managed runtime — you define an agent (model + system prompt + tools),
the platform handles sandboxed execution, credential management, and session state.

**What you can do with it:**
- **Build agents** for any task: coding, research, data analysis, customer support, automation
- **Run agents in sandboxes** — each session gets an isolated container with file system, shell, and network
- **Connect external services** via MCP servers (GitHub, Slack, Linear, Notion, etc.) with OAuth
- **Use any LLM** — Anthropic, OpenAI, DeepSeek, or any OpenAI-compatible provider
- **Install community skills** from ClawHub to extend agent capabilities
- **Manage credentials** securely in vaults — agents get scoped access, secrets never leak
- **Collaborate** — multi-user workspace with API key access for CLI/SDK integration

## Creating an Agent

### Flow

1. **Understand the goal** — ask what the agent should do. If vague, one question:
   "What's the main task?" Two rounds max, then build.

2. **Pick the model** — check `/v1/model_cards` first. Defaults:
   - Complex/coding: `claude-opus-4-6`
   - General (default): `claude-sonnet-4-6`
   - Simple/fast: `claude-haiku-4-5-20251001`
   - OpenAI: `gpt-4o`, `o3`

3. **Write system prompt** — specific, actionable, bounded. Not generic.

4. **Select tools** — default `agent_toolset_20260401` (file ops, bash, web) covers most cases.

5. **Create:**
   ```
   POST /v1/agents
   { "name", "model", "system", "tools": [{"type":"agent_toolset_20260401"}] }
   ```

6. **Next steps** — offer to create session, configure skills, set up model card.

## Platform Quick Ref

Agents need a **session** to run. Sessions need an **environment** (sandbox).

| Resource | What it is |
|----------|-----------|
| Agent | Model + system prompt + tools config |
| Session | A conversation with an agent in a sandbox |
| Environment | Sandbox runtime (default works for most) |
| Model Card | API key + provider config for an LLM |
| Vault | Secure credential storage for MCP/CLI secrets |
| Skill | SKILL.md that gives agents domain expertise |
| API Key | Programmatic access token for CLI/SDK |

```
oma agents create <name>                    # create agent
oma sessions create --agent <id> --env <id> # start session
oma sessions message <id> <text>            # send message
oma models create --name <n> --model-id <id> --api-key <key>
oma keys create                             # generate API key
oma skills install <slug>                   # install from ClawHub
oma --help                                  # full command list
```

Model card providers: `ant`, `oai`, `ant-compatible`, `oai-compatible`.
