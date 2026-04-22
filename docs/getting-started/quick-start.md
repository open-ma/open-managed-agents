# Quick Start

This guide will walk you through creating your first agent with Open Managed Agents.

## Basic Agent Example

```typescript
import { createAgent, createRuntime } from 'agents'
import { anthropic } from '@ai-sdk/anthropic'

// Define your agent
const agent = createAgent({
  model: anthropic('claude-3-5-sonnet-20241022'),
  tools: {
    // Add your tools here
  },
  instructions: 'You are a helpful assistant.'
})

// Run the agent
const result = await agent.run({
  input: 'Hello, how can you help me?'
})
```

## Next Steps

- [Architecture Overview](../architecture/) - Learn about the system design
- Check out the [examples](../examples/) folder for more agent templates
