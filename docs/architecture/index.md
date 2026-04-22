# Architecture

Open Managed Agents (OMA) is built with a modular architecture that separates concerns and enables flexible agent execution.

## Core Components

### Agent Runtime

The agent runtime provides the execution environment for AI agents. It handles:

- **Tool Execution** - Sandboxed tool access with timeouts and error handling
- **State Management** - Persistent state across agent runs
- **Model Integration** - Unified interface for multiple AI providers

### Message Protocol

Agents communicate through a structured message protocol that supports:

- Text messages
- Tool calls and results
- Handoffs between agents
- Error handling

### Cloud Deployment

The system is designed for Cloudflare Workers, providing:

- Serverless execution
- Global edge distribution
- Durable Object state persistence

## System Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      Cloudflare Workers                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
│  │   Console   │    │  Main App   │    │  Agent App   │     │
│  │   (Vite)    │    │  (HTTP)     │    │  ( Durable)  │     │
│  └─────────────┘    └─────────────┘    └─────────────┘     │
│                            │                  │            │
│                            └────────┬─────────┘            │
│                                     │                       │
│                            ┌────────▼─────────┐             │
│                            │  Agent Runtime  │             │
│                            │  - Tool Executor│             │
│                            │  - State Store  │             │
│                            │  - Model Router │             │
│                            └─────────────────┘             │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

1. **Separation of Concerns** - Console, API, and agent runtime are separate apps
2. **Durable Execution** - Agents use Durable Objects for stateful execution
3. **Provider Abstraction** - Unified interface for Anthropic and OpenAI models
4. **Type Safety** - Full TypeScript with runtime validation via Zod
