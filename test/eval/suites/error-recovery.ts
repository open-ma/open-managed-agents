import type { EvalTask } from "../types.js";
import { DEFAULT_TOOLS, DEFAULT_SYSTEM } from "../types.js";
import {
  assertToolUsed,
  assertToolResultContains,
  assertIdleNoError,
  assertLastBashSuccess,
  allOf,
} from "../verify.js";

export const errorRecoverySuite: EvalTask[] = [
  // T4.1 — File Not Found Recovery (Easy)
  {
    id: "T4.1-file-not-found",
    category: "error-recovery",
    difficulty: "easy",
    description: "Handle missing file gracefully",
    agentConfig: { system: DEFAULT_SYSTEM, tools: DEFAULT_TOOLS },
    turns: [
      {
        message: `Read the file /workspace/config.yaml. If it doesn't exist, create it with this content:
server:
  host: 0.0.0.0
  port: 8080
Then read it again to confirm.`,
        verify: (events) => assertIdleNoError(events),
      },
      {
        message: "Run: cat /workspace/config.yaml",
        verify: (events) =>
          assertToolResultContains(events, "bash", "0.0.0.0"),
      },
    ],
  },

  // T4.2 — Syntax Error Fix (Medium)
  {
    id: "T4.2-syntax-error",
    category: "error-recovery",
    difficulty: "medium",
    description: "Fix a syntax error after seeing the error",
    agentConfig: { system: DEFAULT_SYSTEM, tools: DEFAULT_TOOLS },
    // No setupFiles — combine setup and eval in one turn to avoid extra LLM call
    turns: [
      {
        message: `First, create /workspace/broken.py with this exact content:

def greet(name):
    message = f"Hello, {name}!"
    print(message

greet("World")

Then run it with bash. It has a syntax error. Fix the error and run it again.`,
        verify: (events) =>
          allOf(
            assertToolUsed(events, "bash"),
            assertLastBashSuccess(events),
            assertIdleNoError(events),
          ),
      },
    ],
  },

  // T4.3 — Missing Dependency (Medium)
  {
    id: "T4.3-missing-dependency",
    category: "error-recovery",
    difficulty: "medium",
    description: "Install missing Python package and retry",
    agentConfig: { system: DEFAULT_SYSTEM, tools: DEFAULT_TOOLS },
    setupFiles: [
      {
        path: "/workspace/script.py",
        content: `import yaml

data = {"name": "test", "version": 1}
result = yaml.dump(data)
print(result)
print("SCRIPT_SUCCESS")
`,
      },
    ],
    turns: [
      {
        message:
          "Run /workspace/script.py. If it fails due to a missing module, install it and try again.",
        verify: (events) =>
          allOf(
            assertToolUsed(events, "bash"),
            assertToolResultContains(events, "bash", "SCRIPT_SUCCESS"),
            assertIdleNoError(events),
          ),
      },
    ],
  },

  // T4.4 — Directory Creation (Medium)
  {
    id: "T4.4-directory-creation",
    category: "error-recovery",
    difficulty: "medium",
    description: "Write file to non-existent directory path",
    agentConfig: { system: DEFAULT_SYSTEM, tools: DEFAULT_TOOLS },
    turns: [
      {
        message:
          'Write a file at /workspace/output/results/data.json with the content {"status": "complete", "count": 42}',
        verify: (events) => assertIdleNoError(events),
      },
      {
        message: "Run: cat /workspace/output/results/data.json",
        verify: (events) =>
          allOf(
            assertToolResultContains(events, "bash", "complete"),
            assertToolResultContains(events, "bash", "42"),
          ),
      },
    ],
  },

  // T4.5 — Cascading Error Recovery (Hard)
  {
    id: "T4.5-cascading-recovery",
    category: "error-recovery",
    difficulty: "hard",
    description: "Handle git clone failure and recover by creating files manually",
    agentConfig: { system: DEFAULT_SYSTEM, tools: DEFAULT_TOOLS },
    turns: [
      {
        message: `Do these steps:
1. Try to clone https://github.com/nonexistent-user-xxxxx/nonexistent-repo-yyyyy.git to /workspace/repo (this will fail — that's expected)
2. Since the clone failed, create the project manually:
   - /workspace/repo/src/main.py with a print("hello world") statement
   - /workspace/repo/README.md with "# My Project"
3. Initialize a git repo: cd /workspace/repo && git init
4. Stage and commit: git add -A && git commit -m "initial commit"
5. Run: git log --oneline`,
        verify: (events) =>
          allOf(
            assertToolUsed(events, "bash"),
            assertToolResultContains(events, "bash", "initial commit"),
            assertIdleNoError(events),
          ),
      },
    ],
  },
];
