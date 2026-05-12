---
title: "Hello, openma"
description: "Why we're building an open-source meta-harness for AI agents — and why BYOK matters."
publishedAt: 2026-05-08
author: openma
tags: ["intro", "byok"]
---

We're building openma because the agent infrastructure layer is too important
to be a closed black box.

## What's a meta-harness?

A harness is the loop that runs an agent: read events, build context, call
the model, dispatch tools, persist state, recover from crashes. Most teams
end up writing one. They're roughly the same.

A **meta-harness** is the platform that runs harnesses — sessions, sandboxes,
event log, memory, vaults, tools, integrations. The boring infrastructure
your harness needs but doesn't want to own.

openma is a meta-harness. Write a harness. Deploy. The platform handles
the rest.

## Why BYOK

We don't want to be in the business of marking up tokens. You already pay
Anthropic / OpenAI / OpenRouter directly. Adding our own token margin on
top would mean a worse rate for the same model, with no value added.

So we charge for what we actually run: the sandbox. localRuntime is free
forever. Cloud sandbox is $0.005/min, billed in 1-minute increments.

## What's next

We're publishing the cloud-runtime + Console at openma.dev now (early access)
and the self-host story (Docker + SQLite or Postgres) shortly after. Star
[the repo](https://github.com/open-ma/open-managed-agents) to follow along.
