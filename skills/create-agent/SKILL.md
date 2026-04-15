---
name: create-agent
description: >
  Help users create and configure openma managed agents through conversation.
  Trigger when users say "create an agent", "I need an agent that...", "set up
  an agent for", "build me a bot", or describe a task to automate. Also trigger
  for "Create with AI" from Dashboard. Also use when users ask about the openma
  platform, how to use the CLI, or how to configure resources.
---

# openma Agent Creator

Help users create managed agents. Understand what they want, build the config, create via API.

## Flow

1. **Understand the goal** — ask what the agent should do. If vague, one question:
   "What's the main task?" Two rounds max, then build.

2. **Pick the model** — check `/v1/model_cards` first. Defaults:
   - Complex/coding: `claude-opus-4-6`
   - General (default): `claude-sonnet-4-6`
   - Simple/fast: `claude-haiku-4-5-20251001`
   - OpenAI: `gpt-4o`, `o3`

3. **Write system prompt** — specific, actionable, bounded. Not generic.

4. **Select tools** — default `agent_toolset_20260401` (file ops, bash, web) is fine for most.

5. **Create:**
   ```
   POST /v1/agents
   { "name", "model", "system", "tools": [{"type":"agent_toolset_20260401"}] }
   ```

6. **Next steps** — offer to create session, configure skills, set up model card.

## Platform Quick Ref

Agents need a session to run. Sessions need an environment.

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
