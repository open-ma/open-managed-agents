# Installation

## Clone the Repository

```bash
git clone https://github.com/open-ma/open-managed-agents.git
cd open-managed-agents
```

## Install Dependencies

This project uses pnpm workspaces:

```bash
pnpm install
```

## Environment Setup

Copy the example environment file and configure your credentials:

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` and add your API keys:

```env
ANTHROPIC_API_KEY=your_anthropic_api_key
OPENAI_API_KEY=your_openai_api_key
```

## Verify Installation

Run the type checker to verify everything is set up correctly:

```bash
pnpm typecheck
```

## Build the Console

To build the web console:

```bash
pnpm build:console
```

## Next Steps

- [Quick Start](./quick-start) - Build your first agent
