---
title: "Claude Tag Open-Source Alternative: Self-Hosted with OpenMA"
description: "Claude Tag is hosted and closed. Here is how Open Managed Agents becomes the open-source, self-hosted foundation for a Claude Tag-style agent."
publishedAt: 2026-06-25
author: openma
tags: ["claude-tag", "open-source", "self-hosted", "alternatives", "integrations"]
---

[Claude Tag](https://www.anthropic.com/news/introducing-claude-tag)
is Anthropic's new Slack-native way to work with Claude. Tag `@Claude`
in a channel, give it a task, and it can work asynchronously using the
tools and context an administrator has approved. It is multiplayer,
channel-scoped, and designed for the moment when an AI agent stops being
a private chat box and starts behaving more like a teammate.

That product direction is exactly right. The question for many teams is
whether the agent teammate should be a closed, Anthropic-hosted surface
or an open platform they can run, inspect, and extend themselves.

Open Managed Agents is not a pixel-for-pixel Claude Tag clone. It is an
open-source agent runtime with Slack, GitHub, Linear, MCP, vaults,
sandboxes, memory, and crash recovery. If what you want is an
open-source, self-hosted Claude Tag-style foundation that can use your
own model keys and live next to the rest of your agent infrastructure,
it is the more flexible path.

## What Claude Tag is

Claude Tag replaces Anthropic's older Claude in Slack app for eligible
organizations. According to Anthropic, it is available in beta for
Claude Enterprise and Team customers, works in Slack today, and runs on
Claude Opus 4.8.

The important product ideas are:

- **Channel-native collaboration.** A Slack channel gets a shared
  `@Claude` identity rather than every person running isolated chats.
- **Asynchronous work.** Claude can break a request into stages, work in
  the background, and come back to the Slack thread when done.
- **Scoped memory.** Claude can remember useful channel and workspace
  context, with boundaries set by administrators.
- **Admin-controlled access.** Owners choose which channels, tools,
  repositories, and credentials Claude can use.
- **Spend controls and audit.** Admins can set organization and
  per-channel limits, review activity, and track usage.

Those are the right primitives for a real workplace agent. They are also
the primitives that make teams ask harder questions: where does memory
live, who owns the tool layer, can we change the agent loop, what
happens if we want a model other than Claude, and can this run in our
own environment?

## Why teams look for a Claude Tag alternative

Most teams do not need an alternative because Claude Tag is weak. They
need one because the strongest version of the idea becomes
infrastructure.

Common reasons:

- **Self-hosting.** Some organizations cannot send Slack-derived work,
  tool calls, repository access, and persistent memory through a
  third-party hosted agent service.
- **Model choice.** Claude is excellent, but production agent platforms
  often need Anthropic, OpenAI, OpenRouter, local models, or a private
  gateway under the same policy layer.
- **Custom harness logic.** Teams want control over compaction,
  retrieval, prompt caching, retry policy, stop conditions, and tool
  scheduling.
- **Integration ownership.** Slack is rarely enough. Agents also need to
  act in GitHub, Linear, Lark, Jira, internal dashboards, data
  warehouses, and private APIs.
- **Cost visibility.** BYOK lets the team see model spend directly with
  the provider, while the platform bill stays tied to compute and
  orchestration.
- **Audit and data residency.** Some teams need the event log, memory,
  credential vaults, and sandbox outputs in their own region or account.

That is the gap Open Managed Agents is designed for.

## Claude Tag vs Open Managed Agents

| | Claude Tag | Open Managed Agents |
|---|---|---|
| Primary surface | Slack | Slack, GitHub, Linear, API, MCP |
| Source | Closed | Apache 2.0 |
| Hosting | Anthropic-hosted | Hosted or self-hosted |
| Models | Claude | BYOK: Anthropic, OpenAI, OpenRouter, compatible gateways |
| Slack identity | Shared `@Claude` experience | Dedicated per-agent Slack app publication |
| Channel model | Channel-scoped Claude | Per-channel sessions for a published agent |
| Memory | Claude Tag channel/workspace memory | Platform memory stores under your deployment |
| Tools | Admin-enabled tools and repositories | Built-in tools, MCP servers, custom integration providers |
| Sandbox | Anthropic-managed | Cloudflare Containers, LiteBox, E2B, Daytona, BoxRun |
| Agent loop | Anthropic-managed | Default harness or your own harness |
| Best fit | Teams already standardized on Claude Enterprise/Team | Teams that want open, self-hosted, model-flexible agent infrastructure |

The difference is not just deployment. Claude Tag is a product surface.
Open Managed Agents is the platform layer underneath a product surface.
That means more setup, but also more control.

## How Slack works in Open Managed Agents

Open Managed Agents publishes an agent into Slack as its own dedicated
Slack App. The agent can be mentioned in channels, reply in threads,
join DMs, and keep one running session per publication and channel.

In practical terms:

- A team creates an agent with a model, system prompt, tools, skills,
  vaults, and optional memory stores.
- The agent is published into Slack through a per-publication Slack App
  manifest flow.
- Slack `app_mention`, DM, thread reply, and channel events become
  session dispatches.
- The agent gets Slack MCP tools and can also use GitHub, Linear, web,
  shell, file, and custom tools if granted.
- Events are stored in the Open Managed Agents session log so the agent
  can resume after crashes and keep a durable history.

That makes it possible to build a Claude Tag-style workflow, but with
your own deployment, your own integration boundaries, and your own
harness code.

## Where Claude Tag is better

Use Claude Tag if you want the fastest Slack-native Claude experience
and your organization is already comfortable with Anthropic controlling
the product surface.

It is especially strong when:

- You are on Claude Enterprise or Team.
- Slack is the only surface you care about right now.
- You want Anthropic to own setup, agent behavior, and ongoing product
  details.
- You prefer a managed beta over operating an agent platform.
- Your compliance model allows Anthropic-hosted workplace agents.

That is a good product choice. It just is not the only architecture.

## Where Open Managed Agents is better

Use Open Managed Agents when the Claude Tag-style experience is one
piece of a larger agent system.

It is the better fit when:

- You need to self-host on Cloudflare, Docker, a VPS, or your own
  network.
- You want a Tag-style agent that can also be assigned GitHub issues,
  comment on PRs, update Linear, call MCP servers, and run code in a
  sandbox.
- You want to inspect and modify the harness.
- You need model portability instead of a Claude-only runtime.
- You need vaults, logs, memory, and workspace files under your own
  operational control.

Open Managed Agents keeps the shared workplace-agent shape, but makes it
infrastructure you can own.

## Quick start

For the fastest local path:

```bash
git clone https://github.com/openma-ai/open-managed-agents.git
cd open-managed-agents
cp .env.example .env

# Set BETTER_AUTH_SECRET and PLATFORM_ROOT_SECRET in .env.
# Optionally set ANTHROPIC_API_KEY for the first local agent.
docker compose up -d
```

Then open the Console, create an agent, and publish it into Slack from
the integrations flow. For a full production deployment, start with the
[self-host overview](https://docs.openma.dev/self-host/overview/) and
the [Slack OAuth app setup](https://docs.openma.dev/self-host/oauth-apps/#slack).

## Bottom line

Claude Tag proves that the winning agent UI may be the place where work
already happens: Slack threads, shared channels, follow-ups, code
reviews, support triage, and incident rooms.

Open Managed Agents takes the same thesis seriously, but answers a
different buyer question: what if the Claude Tag-style workflow should
be open, self-hostable, model-flexible, and wired into the rest of your
agent platform?

If that is the constraint, Open Managed Agents is the Claude Tag
alternative worth testing.

Related reading:
[Claude Managed Agents vs Open Managed Agents](/blog/claude-managed-agents-vs-open-managed-agents/),
[self-hosting on Cloudflare](/blog/self-host-agent-platform-cloudflare-workers/),
and [the open-source alternatives landscape](/blog/open-source-alternatives-to-claude-managed-agents-2026/).
