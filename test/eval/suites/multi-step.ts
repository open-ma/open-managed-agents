import type { EvalTask } from "../types.js";
import { DEFAULT_TOOLS, DEFAULT_SYSTEM } from "../types.js";
import {
  assertToolUsed,
  assertToolResultContains,
  assertIdleNoError,
  assertLastBashSuccess,
  assertMinToolCalls,
  allOf,
} from "../verify.js";
import { all, includes, toolUsed } from "@open-managed-agents/shared";

export const multiStepSuite: EvalTask[] = [
  // T3.1 — Data Pipeline (Medium)
  {
    id: "T3.1-data-pipeline",
    category: "multi-step",
    difficulty: "medium",
    description: "Create data, analyze it, and produce a report",
    agentConfig: { system: DEFAULT_SYSTEM, tools: DEFAULT_TOOLS },
    turns: [
      {
        message: `Complete these steps:
1. Create /workspace/sales.csv with 10 rows of sales data (columns: date,product,quantity,price). Use realistic fake data with at least 3 different products.
2. Write a Python script /workspace/analyze.py that reads the CSV and calculates:
   - Total revenue (sum of quantity * price for each row)
   - Best-selling product (highest total quantity)
   - Average price across all rows
3. Run the script.
4. Save the results to /workspace/report.txt`,
        verify: (events) =>
          allOf(
            assertMinToolCalls(events, 4),
            assertToolUsed(events, "bash"),
            assertIdleNoError(events),
          ),
      },
      {
        message: "Run: cat /workspace/report.txt",
        verify: (events) =>
          allOf(
            assertToolUsed(events, "bash"),
            // Report should contain numeric values
            assertToolResultContains(events, "bash", "revenue"),
          ),
      },
    ],
    // Phase 2 scorer: case-insensitive match fixes the prior false-negative
    // where the agent wrote "Total Revenue" but verifier checked lowercase.
    scorer: all(toolUsed("bash"), includes("revenue")),
  },

  // T3.2 — Codebase Exploration (Medium)
  {
    id: "T3.2-codebase-exploration",
    category: "multi-step",
    difficulty: "medium",
    description: "Explore a project and answer questions",
    agentConfig: { system: DEFAULT_SYSTEM, tools: DEFAULT_TOOLS },
    setupFiles: [
      {
        path: "/workspace/project/main.py",
        content: `# TODO: add error handling
def process_data(items):
    return [x * 2 for x in items]

def format_output(data):
    return "\\n".join(str(x) for x in data)

# TODO: support CSV output
def save_results(data, path):
    with open(path, "w") as f:
        f.write(format_output(data))
`,
      },
      {
        path: "/workspace/project/utils/helpers.py",
        content: `def validate_input(items):
    return all(isinstance(x, (int, float)) for x in items)

def load_config(path):
    import json
    with open(path) as f:
        return json.load(f)
`,
      },
      {
        path: "/workspace/project/utils/__init__.py",
        content: "",
      },
      {
        path: "/workspace/project/tests/test_main.py",
        content: `from main import process_data, format_output

def test_process():
    assert process_data([1, 2, 3]) == [2, 4, 6]

def test_format():
    assert format_output([1, 2]) == "1\\n2"
`,
      },
    ],
    turns: [
      {
        message: `Explore /workspace/project/ and answer these questions. Save answers to /workspace/answers.txt:
1. How many Python files are in the project (including subdirectories)?
2. What are the function names defined in main.py?
3. How many TODO comments are in the entire project?`,
        verify: (events) => assertIdleNoError(events),
      },
      {
        message: "Run: cat /workspace/answers.txt",
        verify: (events) =>
          allOf(
            assertToolUsed(events, "bash"),
            // Should mention 4 python files, 3 functions, 2 TODOs
            assertToolResultContains(events, "bash", "4"),
            assertToolResultContains(events, "bash", "2"),
          ),
      },
    ],
  },

  // T3.3 — Debug from Error Log (Hard)
  {
    id: "T3.3-debug-from-log",
    category: "multi-step",
    difficulty: "hard",
    description: "Trace and fix a bug from an error log",
    agentConfig: { system: DEFAULT_SYSTEM, tools: DEFAULT_TOOLS },
    setupFiles: [
      {
        path: "/workspace/webapp/error.log",
        content: `Traceback (most recent call last):
  File "/workspace/webapp/app.py", line 5, in process_request
    result = transform(data["payload"])
  File "/workspace/webapp/transform.py", line 3, in transform
    return [item.strip().upper() for item in items]
AttributeError: 'int' object has no attribute 'strip'
`,
      },
      {
        path: "/workspace/webapp/app.py",
        content: `from transform import transform

def process_request(data):
    result = transform(data["payload"])
    return {"processed": result}

if __name__ == "__main__":
    test_data = {"payload": ["hello", "world", 42, "test"]}
    print(process_request(test_data))
`,
      },
      {
        path: "/workspace/webapp/transform.py",
        content: `def transform(items):
    return [item.strip().upper() for item in items]
`,
      },
    ],
    turns: [
      {
        message:
          "The app at /workspace/webapp/ is crashing. Read error.log, trace through the source, fix the bug, and run app.py to verify it works.",
        verify: (events) =>
          allOf(
            assertToolUsed(events, "bash"),
            assertLastBashSuccess(events),
            assertIdleNoError(events),
          ),
      },
    ],
  },

  // T3.4 — Multi-Turn Iteration (Hard)
  {
    id: "T3.4-multi-turn",
    category: "multi-step",
    difficulty: "hard",
    description: "Build incrementally across multiple turns",
    agentConfig: { system: DEFAULT_SYSTEM, tools: DEFAULT_TOOLS },
    turns: [
      {
        message: `Create a Python module at /workspace/mathlib.py with these functions:
- factorial(n): returns n! (iterative, not recursive)
- fibonacci(n): returns the nth fibonacci number (0-indexed, fib(0)=0, fib(1)=1)
- is_prime(n): returns True if n is prime

Then create /workspace/test_mathlib.py with thorough tests and run it.`,
        verify: (events) =>
          allOf(
            assertToolUsed(events, "bash"),
            assertLastBashSuccess(events),
            assertIdleNoError(events),
          ),
      },
      {
        message: `Add a new function gcd(a, b) to /workspace/mathlib.py that computes the greatest common divisor using Euclid's algorithm. Add tests for gcd to test_mathlib.py and re-run all tests.`,
        verify: (events) =>
          allOf(
            assertToolUsed(events, "bash"),
            assertLastBashSuccess(events),
            assertIdleNoError(events),
          ),
      },
    ],
  },
];
