import type { EvalTask } from "../types.js";
import { DEFAULT_TOOLS, DEFAULT_SYSTEM } from "../types.js";
import {
  assertToolUsed,
  assertToolResultContains,
  assertIdleNoError,
  assertToolOrder,
  assertLastBashSuccess,
  allOf,
} from "../verify.js";

export const toolUseSuite: EvalTask[] = [
  // T1.1 — File Write and Verify (Easy)
  {
    id: "T1.1-file-write",
    category: "tool-use",
    difficulty: "easy",
    description: "Write a file and verify its content",
    agentConfig: { system: DEFAULT_SYSTEM, tools: DEFAULT_TOOLS },
    turns: [
      {
        message:
          'Create a file at /workspace/greeting.txt containing exactly the text "Hello, World!" (no quotes, no trailing newline). Do not add any extra content.',
        verify: (events) => assertIdleNoError(events),
      },
      {
        message: "Run: cat /workspace/greeting.txt",
        verify: (events) =>
          allOf(
            assertToolUsed(events, "bash"),
            assertToolResultContains(events, "bash", "Hello, World!"),
          ),
      },
    ],
  },

  // T1.2 — Grep Search (Medium)
  {
    id: "T1.2-grep-search",
    category: "tool-use",
    difficulty: "medium",
    description: "Create a CSV and grep for matching rows",
    agentConfig: { system: DEFAULT_SYSTEM, tools: DEFAULT_TOOLS },
    turns: [
      {
        message: `Create a file /workspace/data.csv with this exact content:
name,age,city
Alice,30,NYC
Bob,25,LA
Charlie,35,NYC
Diana,28,Chicago

Then use the grep tool to find all lines containing "NYC" in /workspace/data.csv.`,
        verify: (events) =>
          allOf(
            assertToolUsed(events, "grep"),
            assertToolResultContains(events, "grep", "Alice"),
            assertToolResultContains(events, "grep", "Charlie"),
            assertIdleNoError(events),
          ),
      },
    ],
  },

  // T1.3 — Edit Tool Precision (Medium)
  {
    id: "T1.3-edit-precision",
    category: "tool-use",
    difficulty: "medium",
    description: "Use edit tool for precise string replacement",
    agentConfig: { system: DEFAULT_SYSTEM, tools: DEFAULT_TOOLS },
    turns: [
      {
        message: `Create a file /workspace/config.json with this content:
{"host": "localhost", "port": 3000, "debug": true}

Then use the edit tool to change the port from 3000 to 8080.`,
        verify: (events) =>
          allOf(
            assertToolUsed(events, "edit"),
            assertIdleNoError(events),
          ),
      },
      {
        message: "Run: cat /workspace/config.json",
        verify: (events) =>
          allOf(
            assertToolResultContains(events, "bash", "8080"),
            assertToolResultContains(events, "bash", "debug"),
          ),
      },
    ],
  },

  // T1.4 — Glob Pattern Matching (Easy)
  {
    id: "T1.4-glob-pattern",
    category: "tool-use",
    difficulty: "easy",
    description: "Use glob to find files by pattern",
    agentConfig: { system: DEFAULT_SYSTEM, tools: DEFAULT_TOOLS },
    turns: [
      {
        message: `Create these files (any content is fine):
/workspace/src/main.ts
/workspace/src/utils.ts
/workspace/src/tests/test1.ts
/workspace/README.md

Then use the glob tool with pattern "**/*.ts" to find all TypeScript files under /workspace.`,
        verify: (events) =>
          allOf(
            assertToolUsed(events, "glob"),
            assertToolResultContains(events, "glob", "main.ts"),
            assertToolResultContains(events, "glob", "test1.ts"),
            assertIdleNoError(events),
          ),
      },
    ],
  },

  // T1.5 — Bash Background Task (Hard)
  {
    id: "T1.5-bash-background",
    category: "tool-use",
    difficulty: "hard",
    description: "Start a background process and interact with it",
    agentConfig: { system: DEFAULT_SYSTEM, tools: DEFAULT_TOOLS },
    turns: [
      {
        message: `Do the following steps:
1. Create a file /workspace/index.html with content "<h1>Hello</h1>"
2. Start a Python HTTP server in /workspace on port 9999 in the background: python3 -m http.server 9999 --directory /workspace
3. Wait a couple seconds, then run: curl -s http://localhost:9999/
4. Report what you see.`,
        verify: (events) =>
          allOf(
            assertToolUsed(events, "bash"),
            assertToolResultContains(events, "bash", "Hello"),
            assertIdleNoError(events),
          ),
      },
    ],
  },
];
