import type { EvalTask } from "../types.js";
import { DEFAULT_TOOLS, DEFAULT_SYSTEM } from "../types.js";
import {
  assertToolUsed,
  assertToolResultContains,
  assertIdleNoError,
  assertLastBashSuccess,
  assertMinToolCalls,
  eventsOfType,
  allOf,
} from "../verify.js";

// Note: Multi-agent evals require creating sub-agents at runtime.
// The `subAgents` field is used by the runner to create these agents
// and inject their IDs into the parent's `callable_agents` config.

export const multiAgentSuite: EvalTask[] = [
  // T5.1 — Simple Delegation (Medium)
  {
    id: "T5.1-simple-delegation",
    category: "multi-agent",
    difficulty: "medium",
    description: "Delegate research to sub-agent, then use result",
    agentConfig: {
      system:
        "You are a coordinator. When you need information, delegate to available sub-agents using the call_agent tools. Use their responses to complete your task.",
      tools: DEFAULT_TOOLS,
    },
    subAgents: [
      {
        name: "researcher",
        system:
          "You are a concise research assistant. Answer questions directly and briefly. Do not use tools unless necessary.",
        tools: DEFAULT_TOOLS,
      },
    ],
    turns: [
      {
        message:
          "Ask the researcher agent what the Fibonacci sequence is. Then use that information to write a Python function at /workspace/fib.py that returns the nth Fibonacci number. Run a quick test: python3 -c 'from fib import fibonacci; print(fibonacci(10))'",
        verify: (events) => {
          // Check for thread events (delegation happened)
          const threadCreated = eventsOfType(events, "session.thread_created");
          const hasWrite = assertToolUsed(events, "write");
          const hasBash = assertToolUsed(events, "bash");
          const noError = assertIdleNoError(events);

          if (threadCreated.length === 0) {
            return {
              status: "fail",
              message: "No sub-agent delegation occurred (no session.thread_created event)",
            };
          }

          return allOf(hasWrite, hasBash, noError);
        },
      },
    ],
  },

  // T5.2 — Multi-Agent Coordination (Hard)
  {
    id: "T5.2-multi-agent-coordination",
    category: "multi-agent",
    difficulty: "hard",
    description: "Coordinate two sub-agents to build and test code",
    agentConfig: {
      system: `You are a project coordinator. You have two sub-agents available:
- code-writer: writes implementation code
- test-writer: writes test code
Delegate appropriately, then verify the work yourself by running the tests.`,
      tools: DEFAULT_TOOLS,
    },
    subAgents: [
      {
        name: "code-writer",
        system:
          "You are a code writer. Write clean Python code as requested. Save files to the paths specified.",
        tools: DEFAULT_TOOLS,
      },
      {
        name: "test-writer",
        system:
          "You are a test writer. Write comprehensive Python tests as requested. Save files to the paths specified. Use assert statements and print 'ALL_TESTS_PASSED' at the end.",
        tools: DEFAULT_TOOLS,
      },
    ],
    turns: [
      {
        message: `I need:
1. Ask the code-writer to create /workspace/sort.py with a function merge_sort(arr) that implements merge sort.
2. Ask the test-writer to create /workspace/test_sort.py with tests for merge_sort (empty list, single element, already sorted, reverse sorted, duplicates). Tests should print "ALL_TESTS_PASSED".
3. Run the tests yourself with bash.`,
        verify: (events) => {
          const threads = eventsOfType(events, "session.thread_created");
          const hasBash = assertToolUsed(events, "bash");
          const noError = assertIdleNoError(events);

          if (threads.length < 2) {
            return {
              status: "fail",
              message: `Expected at least 2 sub-agent delegations, got ${threads.length}`,
            };
          }

          return allOf(hasBash, noError);
        },
      },
    ],
    timeoutMs: 600_000, // 10 min — multi-agent takes longer
  },

  // T5.3 — Delegation with Error Handling (Hard)
  {
    id: "T5.3-delegation-error-handling",
    category: "multi-agent",
    difficulty: "hard",
    description: "Handle sub-agent failure and recover",
    agentConfig: {
      system: `You are a coordinator with a helper sub-agent. The helper may encounter errors — when that happens, fix the issue yourself and try again.`,
      tools: DEFAULT_TOOLS,
    },
    subAgents: [
      {
        name: "helper",
        system:
          "You are a helper. Read files as requested and summarize their contents. If the file doesn't exist, report the error clearly.",
        tools: DEFAULT_TOOLS,
      },
    ],
    turns: [
      {
        message: `Ask the helper agent to read /workspace/data.json and summarize it.
The file doesn't exist yet, so the helper will report an error.
When that happens, create /workspace/data.json yourself with this content: {"users": [{"name": "Alice", "role": "admin"}, {"name": "Bob", "role": "user"}]}
Then ask the helper again to read and summarize it.`,
        verify: (events) => {
          const threads = eventsOfType(events, "session.thread_created");
          const noError = assertIdleNoError(events);

          // Should have at least 2 delegations (first fails, second succeeds)
          // OR coordinator may have written the file and delegated once after
          if (threads.length < 1) {
            return {
              status: "fail",
              message: "No sub-agent delegation occurred",
            };
          }

          return allOf(
            assertToolUsed(events, "write"),
            noError,
          );
        },
      },
    ],
    timeoutMs: 600_000,
  },
];
