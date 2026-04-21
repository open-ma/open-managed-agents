---
name: openma
description: >
  Use the openma platform to build, deploy, and manage AI agents. Trigger when
  users want to create agents, start sessions, manage environments, configure
  model cards, handle vaults/credentials, install skills, connect MCP servers,
  or interact with the openma HTTP API. Also trigger when users mention "oma",
  "openma", "managed agents", or ask how to deploy/run/manage an agent on openma.
---

# openma

openma is an open-source platform for building, deploying, and managing AI agents.
You define an agent (model + system prompt + tools), the platform handles sandboxed
execution, credential management, and session state.

## Setup

```bash
npx open-managed-agents            # or: npm i -g open-managed-agents
export OMA_BASE_URL=https://your-instance.workers.dev
export OMA_API_KEY=oma_xxxxxx      # generate at Console → API Keys
```

Run `oma --help` for all commands.

## Core Workflow

```bash
oma agents create "my-agent" --model claude-sonnet-4-6
oma envs list                      # reuse existing, or:
oma envs create default
oma sessions create --agent <agent-id> --env <env-id>
oma sessions message <session-id> "Your task here"
```

## Resources

| Resource | CLI commands | Purpose |
|----------|-------------|---------|
| Agent | `oma agents create/list/get/delete` | Model + prompt + tools config |
| Environment | `oma envs create/list` | Sandbox runtime for sessions |
| Session | `oma sessions create/list/message` | Conversation with an agent |
| Model Card | `oma models create/list` | LLM API key + provider config |
| Vault | `oma vaults create/list` | Secure credential storage |
| Credential | `oma creds list`, `oma secret add` | Secret inside a vault |
| Skill | `oma skills list/install` | Domain expertise for agents |
| API Key | `oma keys create/list/revoke` | Auth token for CLI/SDK |
| Linear | `oma linear list/pubs/publish/submit/handoff/unpublish/get` | Publish agent into a Linear workspace |

## Model Cards

```bash
oma models create --name "anthropic" --provider ant --model-id claude-sonnet-4-6 --api-key sk-ant-xxx
```

Providers: `ant`, `oai`, `ant-compatible`, `oai-compatible`.

## MCP Server Connections

```bash
oma vaults create "my-vault"
oma connect github --vault <vault-id>
```

Known servers: `airtable`, `amplitude`, `apollo`, `asana`, `atlassian`, `clickup`,
`github`, `intercom`, `linear`, `notion`, `sentry`, `slack`.

## HTTP API Reference

Run `oma api` for the full endpoint reference, or `oma api <resource>` for a specific
resource (agents, sessions, environments, models, vaults, oauth, skills, files,
memory, keys, evals, clawhub).

All `/v1/*` endpoints require `x-api-key` header. Use SSE streaming via
`GET /v1/sessions/:id/stream` for real-time agent responses.

## Tips

- Check `oma agents list` / `oma envs list` before creating — reuse existing resources.
- Sessions are stateful — send multiple messages to continue the conversation.
- Use `oma api sessions` to see the full HTTP API when you need to code against it.
- The `agent_toolset_20260401` tool type gives agents file ops, bash, and web access.

## Integrations

Publish an agent into a third-party tool so it acts as a teammate there.
See [`integrations-linear.md`](integrations-linear.md) for the Linear flow —
covers the OAuth-app handshake, the two moments a human is genuinely needed,
and how to verify / unpublish from the CLI.
