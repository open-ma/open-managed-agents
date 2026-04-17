import type { EvalTask } from "../types.js";
import { DEFAULT_TOOLS } from "../types.js";
import {
  assertToolUsed,
  assertToolResultContains,
  assertIdleNoError,
  assertLastBashSuccess,
  assertMinToolCalls,
  allOf,
} from "../verify.js";
import { all, bashOutputMarker, idleNoError, toolUsed } from "../../../packages/shared/src/index.js";

// Production-grade coding eval tasks based on real-world agent use cases
// References: Anthropic "Demystifying Evals for AI Agents", SWE-bench patterns

export const codingSuite: EvalTask[] = [
  // ---- SWE-bench style: fix a real bug with tests ----
  {
    id: "T2.1-auth-bypass-fix",
    category: "coding",
    difficulty: "medium",
    description: "Fix authentication bypass when password field is empty",
    agentConfig: {
      system: "You are a security-focused backend developer. Fix bugs, write tests, ensure security.",
      tools: DEFAULT_TOOLS,
    },
    turns: [
      {
        message: `There's a security vulnerability in our auth module. Create the following files, then fix the bug and add a test.

Create /workspace/auth.py:
\`\`\`python
import hashlib

USERS = {
    "admin": "5f4dcc3b5aa765d61d8327deb882cf99",  # password123
    "user1": "e10adc3949ba59abbe56e057f20f883e",   # 123456
}

def authenticate(username, password):
    """Returns True if credentials are valid."""
    if username not in USERS:
        return False
    password_hash = hashlib.md5(password.encode()).hexdigest()
    return password_hash == USERS[username]
\`\`\`

Create /workspace/test_auth.py:
\`\`\`python
from auth import authenticate

# Basic tests
assert authenticate("admin", "password123") == True
assert authenticate("admin", "wrong") == False
assert authenticate("nobody", "password123") == False

# Security tests - these should all return False
assert authenticate("admin", "") == False, "Empty password should fail"
assert authenticate("", "") == False, "Empty username and password should fail"
assert authenticate("admin", None) == False, "None password should fail"

print("ALL_SECURITY_TESTS_PASSED")
\`\`\`

Run the test. It will fail on edge cases. Fix auth.py to handle empty/None passwords securely, then re-run.`,
        verify: (events) =>
          allOf(
            assertToolUsed(events, "bash"),
            assertToolResultContains(events, "bash", "ALL_SECURITY_TESTS_PASSED"),
            assertIdleNoError(events),
          ),
      },
    ],
    outcome: {
      description: "The agent should fix the authentication bypass vulnerability where empty/None passwords are accepted",
      rubric: "1. The divide function raises ValueError on zero division\n2. Empty string passwords are rejected\n3. None passwords are handled without crashing\n4. The fix is minimal — only the necessary validation was added\n5. All tests pass",
    },
    // Phase 2 scorer: replaces the legacy outcome judge with a deterministic
    // marker check (the test harness prints ALL_SECURITY_TESTS_PASSED on
    // success, so an LLM judge is overkill — and was the source of the T2.1
    // thinking-model bug in the prior run).
    scorer: all(toolUsed("bash"), bashOutputMarker("ALL_SECURITY_TESTS_PASSED"), idleNoError()),
  },

  // ---- Build a CLI tool from spec with argument parsing ----
  {
    id: "T2.2-cli-tool",
    category: "coding",
    difficulty: "hard",
    description: "Build a CLI tool with argument parsing, file I/O, and error handling",
    agentConfig: {
      system: "You are an expert Python developer. Write clean, production-quality code with proper error handling.",
      tools: DEFAULT_TOOLS,
    },
    turns: [
      {
        message: `Build a CSV statistics CLI tool and its test suite.

Create /workspace/csvstats.py — a CLI tool that:
- Accepts a CSV file path as argument
- Prints summary statistics: row count, column names, numeric column stats (mean, min, max)
- Handles errors gracefully: missing file, invalid CSV, no numeric columns
- Usage: python3 csvstats.py <file.csv>

Create /workspace/test_data.csv:
name,age,salary,department
Alice,30,75000,Engineering
Bob,25,65000,Marketing
Charlie,35,90000,Engineering
Diana,28,70000,Sales
Eve,32,85000,Engineering

Create /workspace/test_csvstats.sh:
\`\`\`bash
#!/bin/bash
set -e
PASS=0
FAIL=0

# Test 1: Normal operation
output=$(python3 /workspace/csvstats.py /workspace/test_data.csv)
echo "$output" | grep -q "5" && echo "PASS: row count" && PASS=$((PASS+1)) || { echo "FAIL: row count"; FAIL=$((FAIL+1)); }
echo "$output" | grep -qi "mean\|average" && echo "PASS: shows mean" && PASS=$((PASS+1)) || { echo "FAIL: shows mean"; FAIL=$((FAIL+1)); }

# Test 2: Missing file
python3 /workspace/csvstats.py /nonexistent.csv 2>&1 | grep -qi "error\|not found\|no such" && echo "PASS: missing file error" && PASS=$((PASS+1)) || { echo "FAIL: missing file error"; FAIL=$((FAIL+1)); }

# Test 3: No arguments
python3 /workspace/csvstats.py 2>&1 | grep -qi "usage\|error\|argument" && echo "PASS: no args error" && PASS=$((PASS+1)) || { echo "FAIL: no args error"; FAIL=$((FAIL+1)); }

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && echo "ALL_CLI_TESTS_PASSED"
\`\`\`

Create all files, then run: bash /workspace/test_csvstats.sh`,
        verify: (events) =>
          allOf(
            assertToolUsed(events, "bash"),
            assertToolResultContains(events, "bash", "ALL_CLI_TESTS_PASSED"),
            assertIdleNoError(events),
          ),
      },
    ],
    scorer: all(toolUsed("bash"), bashOutputMarker("ALL_CLI_TESTS_PASSED"), idleNoError()),
  },

  // ---- Data analysis pipeline ----
  {
    id: "T2.3-data-analysis",
    category: "coding",
    difficulty: "hard",
    description: "Analyze a dataset, generate insights, and produce a structured report",
    agentConfig: {
      system: "You are a data analyst. Analyze data thoroughly, handle edge cases, and produce clear reports.",
      tools: DEFAULT_TOOLS,
    },
    turns: [
      {
        message: `Perform a data analysis task.

Create /workspace/orders.csv with this data (50+ rows of realistic e-commerce orders):
- Columns: order_id, customer_id, product, category, quantity, unit_price, order_date, region
- Include at least 5 categories, 4 regions, dates spanning 3 months
- Include some edge cases: quantity=0 returns, high-value orders, repeat customers

Then write /workspace/analyze_orders.py that:
1. Reads the CSV
2. Calculates:
   - Total revenue and average order value
   - Top 3 products by revenue
   - Revenue by region (sorted descending)
   - Month-over-month growth rate
   - Customer with most orders (repeat buyer analysis)
3. Saves a structured report to /workspace/report.json with all results
4. Prints "ANALYSIS_COMPLETE" when done

Run the analysis script.`,
        verify: (events) =>
          allOf(
            assertToolUsed(events, "bash"),
            assertToolResultContains(events, "bash", "ANALYSIS_COMPLETE"),
            assertIdleNoError(events),
          ),
      },
      {
        message: `Verify the report:
1. Run: python3 -c "import json; r=json.load(open('/workspace/report.json')); print('keys:', list(r.keys())); print('has_revenue:', 'total_revenue' in r or 'revenue' in str(r).lower()); print('has_regions:', 'region' in str(r).lower()); print('REPORT_VALID' if len(r) >= 3 else 'REPORT_INCOMPLETE')"`,
        verify: (events) =>
          allOf(
            assertToolUsed(events, "bash"),
            assertToolResultContains(events, "bash", "REPORT_VALID"),
          ),
      },
    ],
    scorer: all(
      toolUsed("bash"),
      bashOutputMarker("ANALYSIS_COMPLETE"),
      bashOutputMarker("REPORT_VALID"),
      idleNoError(),
    ),
  },

  // ---- Debugging a multi-file application from error traces ----
  {
    id: "T2.4-debug-webapp",
    category: "coding",
    difficulty: "hard",
    description: "Debug a crashing web application from error logs and stack traces",
    agentConfig: {
      system: "You are a senior backend developer debugging a production issue. Trace errors through the codebase, identify root causes, and fix them.",
      tools: DEFAULT_TOOLS,
    },
    turns: [
      {
        message: `A Python web application is crashing. Create the files below, then debug and fix the issues.

Create /workspace/webapp/models.py:
\`\`\`python
class UserRepository:
    def __init__(self):
        self.users = {}

    def add_user(self, user_id, data):
        self.users[user_id] = data

    def get_user(self, user_id):
        return self.users[user_id]  # Bug 1: KeyError if not found

    def get_user_email(self, user_id):
        user = self.get_user(user_id)
        return user["email"].lower()  # Bug 2: AttributeError if email is None
\`\`\`

Create /workspace/webapp/handlers.py:
\`\`\`python
from models import UserRepository

repo = UserRepository()

def handle_signup(data):
    repo.add_user(data["id"], data)
    return {"status": "created", "id": data["id"]}

def handle_profile(user_id):
    user = repo.get_user(user_id)
    email = repo.get_user_email(user_id)
    return {"name": user["name"], "email": email}

def handle_batch_emails(user_ids):
    emails = []
    for uid in user_ids:
        emails.append(repo.get_user_email(uid))
    return emails
\`\`\`

Create /workspace/webapp/test_webapp.py:
\`\`\`python
import sys
sys.path.insert(0, "/workspace/webapp")
from handlers import handle_signup, handle_profile, handle_batch_emails

# Setup
handle_signup({"id": "u1", "name": "Alice", "email": "alice@example.com"})
handle_signup({"id": "u2", "name": "Bob", "email": None})  # No email

# Test 1: Normal profile lookup
result = handle_profile("u1")
assert result["email"] == "alice@example.com", f"Got {result}"

# Test 2: Non-existent user should return None or raise ValueError, not KeyError
try:
    handle_profile("u999")
    assert False, "Should have raised an error"
except (ValueError, KeyError) as e:
    if isinstance(e, KeyError):
        assert False, "Should raise ValueError, not raw KeyError"

# Test 3: User with None email
try:
    handle_profile("u2")
    result = handle_profile("u2")
    # Should handle gracefully, not AttributeError
except AttributeError:
    assert False, "Should handle None email gracefully"

# Test 4: Batch with mixed valid/invalid users
try:
    emails = handle_batch_emails(["u1", "u999", "u2"])
    assert False, "Should handle missing users"
except ValueError:
    pass  # Expected

print("ALL_WEBAPP_TESTS_PASSED")
\`\`\`

Run the tests. They will fail. Read the error, trace through the code, fix the bugs in models.py and/or handlers.py, then re-run until all tests pass.`,
        verify: (events) =>
          allOf(
            assertMinToolCalls(events, 3),
            assertToolUsed(events, "bash"),
            assertToolResultContains(events, "bash", "ALL_WEBAPP_TESTS_PASSED"),
            assertIdleNoError(events),
          ),
      },
    ],
    scorer: all(toolUsed("bash"), bashOutputMarker("ALL_WEBAPP_TESTS_PASSED"), idleNoError()),
  },

  // ---- Refactor + extend existing codebase ----
  {
    id: "T2.5-refactor-extend",
    category: "coding",
    difficulty: "hard",
    description: "Refactor existing code and add new features while keeping tests passing",
    agentConfig: {
      system: "You are a senior developer. Refactor for clarity, add features, and ensure all tests pass.",
      tools: DEFAULT_TOOLS,
    },
    turns: [
      {
        message: `Refactor and extend this task queue system.

Create /workspace/taskqueue/queue.py:
\`\`\`python
class TaskQueue:
    def __init__(self):
        self.tasks = []
        self.completed = []

    def add(self, task_name, priority=0):
        self.tasks.append({"name": task_name, "priority": priority, "status": "pending"})

    def process_next(self):
        if not self.tasks:
            return None
        # Bug: doesn't respect priority — just pops first
        task = self.tasks.pop(0)
        task["status"] = "completed"
        self.completed.append(task)
        return task

    def get_pending(self):
        return [t for t in self.tasks if t["status"] == "pending"]

    def get_completed(self):
        return self.completed
\`\`\`

Create /workspace/taskqueue/test_queue.py:
\`\`\`python
import sys
sys.path.insert(0, "/workspace/taskqueue")
from queue import TaskQueue

# Test 1: Basic add and process
q = TaskQueue()
q.add("task1")
q.add("task2")
result = q.process_next()
assert result["name"] == "task1"
assert len(q.get_pending()) == 1

# Test 2: Priority ordering — higher priority processed first
q2 = TaskQueue()
q2.add("low", priority=1)
q2.add("high", priority=10)
q2.add("medium", priority=5)
result = q2.process_next()
assert result["name"] == "high", f"Expected 'high' priority first, got '{result['name']}'"

# Test 3: Empty queue
q3 = TaskQueue()
assert q3.process_next() is None

# Test 4: Completed tracking
q4 = TaskQueue()
q4.add("a")
q4.add("b")
q4.process_next()
assert len(q4.get_completed()) == 1
assert len(q4.get_pending()) == 1

# NEW FEATURE TESTS — implement these:

# Test 5: Task retry — add retry(task_name) method that moves a completed task back to pending
q5 = TaskQueue()
q5.add("retryable")
q5.process_next()
assert len(q5.get_completed()) == 1
q5.retry("retryable")
assert len(q5.get_pending()) == 1
assert len(q5.get_completed()) == 0

# Test 6: Task stats — add stats() method returning dict with total, pending, completed counts
q6 = TaskQueue()
q6.add("a")
q6.add("b")
q6.add("c")
q6.process_next()
stats = q6.stats()
assert stats == {"total": 3, "pending": 2, "completed": 1}, f"Got {stats}"

print("ALL_QUEUE_TESTS_PASSED")
\`\`\`

Create both files. Run the tests (they will fail). Fix the priority bug, implement the retry() and stats() methods, then re-run until all tests pass.`,
        verify: (events) =>
          allOf(
            assertToolUsed(events, "bash"),
            assertToolResultContains(events, "bash", "ALL_QUEUE_TESTS_PASSED"),
            assertIdleNoError(events),
          ),
      },
    ],
    scorer: all(toolUsed("bash"), bashOutputMarker("ALL_QUEUE_TESTS_PASSED"), idleNoError()),
  },
];
