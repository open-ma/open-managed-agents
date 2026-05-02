/**
 * Convert terminal-bench original-tasks/<name>/ to RLTask JSON.
 *
 * Usage:
 *   npx tsx rl/tasks/terminal-bench/convert.ts <task-name> [<task-name>...]
 *
 * Reads from `tb-source/original-tasks/<name>/` (cloned terminal-bench repo).
 * Writes to `tasks/<name>.json` (one RLTaskSet per file, each with 1 task).
 *
 * The verifier embeds the TB pytest test file via heredoc so the test stays
 * hidden from the agent; the verifier turn writes it to /app/tests/ and runs
 * pytest. Exit code 0 = pass.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TB_SOURCE = join(__dirname, "tb-source", "original-tasks");
const OUT_DIR = join(__dirname, "tasks");

interface ParsedYaml {
  instruction: string;
  difficulty?: string;
  category?: string;
  max_agent_timeout_sec?: number;
  max_test_timeout_sec?: number;
  tags?: string[];
}

/**
 * Rewrite TB's `/app` paths to `/workspace`. Reason: OMA sandbox container
 * has a 10-min idle TTL and only `/workspace` is included in the
 * createBackup snapshot (see `apps/agent/src/runtime/sandbox.ts:79`). Files
 * the agent writes under `/app` are lost as soon as the container is
 * recycled, which makes verifier-after-trial unreliable. Aligning task
 * instruction + test paths with `/workspace` puts everything inside the
 * persistence boundary.
 *
 * Pattern: replace `/app` only when followed by `/`, end-of-string, end-of-line,
 * whitespace, quote, or punctuation — to avoid clobbering `/application` etc.
 */
function rewritePaths(s: string): string {
  return s.replace(/\/app(?=[/'"\s,.;:)\]}>`]|$)/g, "/workspace");
}

function parseTaskYaml(yaml: string): ParsedYaml {
  // Minimal parser for the subset of YAML used by TB tasks. Handles:
  //   instruction: |-      (multi-line block-scalar; strip-chomping)
  //   instruction: |       (multi-line block-scalar; keep trailing newline)
  //   key: value           (simple scalar)
  //   tags:                (sequence)
  //     - foo
  //     - bar
  const out: ParsedYaml = { instruction: "" };
  const lines = yaml.split("\n");

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) {
      i++;
      continue;
    }

    // Top-level key (no leading whitespace before the colon)
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(raw);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    const inlineVal = m[2];

    if (inlineVal === "|-" || inlineVal === "|" || inlineVal === ">-" || inlineVal === ">") {
      const blockLines: string[] = [];
      let baseIndent: number | null = null;
      i++;
      while (i < lines.length) {
        const cur = lines[i];
        if (cur === "") {
          blockLines.push("");
          i++;
          continue;
        }
        const indent = cur.match(/^(\s*)/)![1].length;
        if (baseIndent === null) {
          if (indent === 0) break;
          baseIndent = indent;
        }
        if (indent < baseIndent) break;
        blockLines.push(cur.slice(baseIndent));
        i++;
      }
      let block = blockLines.join("\n");
      if (inlineVal.endsWith("-")) block = block.replace(/\n+$/, "");
      assignKey(out, key, block);
      continue;
    }

    if (inlineVal === "" && i + 1 < lines.length && /^\s*-\s/.test(lines[i + 1])) {
      const items: string[] = [];
      i++;
      while (i < lines.length && /^\s*-\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*-\s+/, "").trim().replace(/^["']|["']$/g, ""));
        i++;
      }
      if (key === "tags") out.tags = items;
      continue;
    }

    assignKey(out, key, inlineVal.trim().replace(/^["']|["']$/g, ""));
    i++;
  }
  return out;
}

function assignKey(out: ParsedYaml, key: string, value: string) {
  switch (key) {
    case "instruction":
      out.instruction = value;
      break;
    case "difficulty":
      out.difficulty = value;
      break;
    case "category":
      out.category = value;
      break;
    case "max_agent_timeout_sec":
      out.max_agent_timeout_sec = parseFloat(value);
      break;
    case "max_test_timeout_sec":
      out.max_test_timeout_sec = parseFloat(value);
      break;
  }
}

function buildVerifyScript(testContent: string): string {
  // Heredoc-inject the test file under /app/tests/, install pytest if missing,
  // then run pytest. The script must not rely on shell quoting magic — we use
  // a single sentinel that's unlikely to appear in test content.
  // If the sentinel ever shows up in tests, conversion will fail loudly (we
  // assert below).
  const SENTINEL = "TBENCH_HEREDOC_END_3F8A2C";
  if (testContent.includes(SENTINEL)) {
    throw new Error(`heredoc sentinel collision: pick a different sentinel`);
  }
  // Detect imported third-party packages so we can pip install them. Skip
  // stdlib + pytest (already installed by the bootstrap below).
  const STDLIB = new Set([
    "os", "sys", "re", "json", "time", "math", "random", "subprocess",
    "pathlib", "hashlib", "base64", "io", "tempfile", "shutil", "collections",
    "itertools", "functools", "typing", "dataclasses", "datetime", "string",
    "csv", "yaml", "argparse", "logging", "unittest", "asyncio", "pickle",
    "ast", "inspect",
  ]);
  const pkgs = new Set<string>();
  // `from X import ...` → top-level X
  for (const m of testContent.matchAll(/^\s*from\s+([A-Za-z_][\w]*)/gm)) {
    pkgs.add(m[1]);
  }
  // `import X` and `import X as Y` (ignore `import X.Y` submodules — top-level wins)
  for (const m of testContent.matchAll(/^\s*import\s+([A-Za-z_][\w]*)/gm)) {
    pkgs.add(m[1]);
  }
  for (const stdlib of STDLIB) pkgs.delete(stdlib);
  pkgs.delete("pytest");
  // Map common import name → pip package name (most match, a few don't)
  const pipNameMap: Record<string, string> = {
    cv2: "opencv-python",
    PIL: "pillow",
    sklearn: "scikit-learn",
    bs4: "beautifulsoup4",
  };
  const pipPkgs = [...pkgs].map((p) => pipNameMap[p] ?? p);
  return [
    // No `set -e` — it interacts badly with the subshell wrap that the
    // sandbox /exec endpoint adds for multi-line commands: pytest exit-1
    // would kill the subshell mid-flush + bury the test output. We rely
    // on pytest's exit code as the canonical pass/fail signal instead.
    "mkdir -p /workspace/tests",
    `cat > /workspace/tests/test_outputs.py <<'${SENTINEL}'`,
    testContent.replace(/\n+$/, ""),
    SENTINEL,
    // Bootstrap pytest if missing (quiet unless something fails)
    // Install via `python3 -m pip` (NOT `pip3`) so the install Python
    // matches the pytest invocation Python. The OMA sandbox image runs
    // python3 inside a venv at /opt/venv — drop `--user` (no user site
    // in venvs) and `--break-system-packages` (the venv isn't externally
    // managed). uv pip --system is the first preference; pip is the
    // fallback for images without uv.
    //
    // `--trusted-host pypi.org --trusted-host files.pythonhosted.org`:
    // the sandbox's outbound HTTPS goes through a Cloudflare TLS proxy
    // CA that may not be in the container's trust store (per-instance
    // SDK trust setup is racey). Bytes-RPC preserves the wheel content,
    // so trusting these specific public mirror hostnames is safe + works
    // around the SSL verify gap.
    "if ! command -v pytest >/dev/null 2>&1; then",
    "  if command -v uv >/dev/null 2>&1; then",
    "    uv pip install --system pytest >/dev/null 2>&1 || python3 -m pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org pytest >/dev/null 2>&1",
    "  else",
    "    python3 -m pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org pytest >/dev/null 2>&1",
    "  fi",
    "fi",
    // Test deps detected from `import` / `from X import` lines. Install
    // each one if not already importable. Output suppressed unless install
    // hits an error.
    ...(pipPkgs.length > 0
      ? [
          `for PKG in ${pipPkgs.map((p) => JSON.stringify(p)).join(" ")}; do`,
          `  PYNAME=$(echo "$PKG" | tr - _)`,
          `  python3 -c "import $PYNAME" >/dev/null 2>&1 && continue`,
          `  if command -v uv >/dev/null 2>&1; then`,
          `    uv pip install --system "$PKG" >/dev/null 2>&1 || python3 -m pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org "$PKG" >/dev/null 2>&1`,
          `  else`,
          `    python3 -m pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org "$PKG" >/dev/null 2>&1`,
          `  fi`,
          `done`,
        ]
      : []),
    // Run pytest. Force unbuffered, merge stderr into stdout, and `exit $?`
    // explicitly so the wrapper subshell exits with pytest's code without
    // losing the captured output.
    "cd /workspace && python3 -u -m pytest -q tests/test_outputs.py 2>&1; pytest_exit=$?",
    "exit $pytest_exit",
  ].join("\n");
}

function convertTask(name: string) {
  const taskDir = join(TB_SOURCE, name);
  if (!existsSync(taskDir)) {
    throw new Error(`task dir not found: ${taskDir}`);
  }
  const yamlPath = join(taskDir, "task.yaml");
  const testPath = join(taskDir, "tests", "test_outputs.py");
  if (!existsSync(yamlPath)) throw new Error(`missing task.yaml: ${yamlPath}`);
  if (!existsSync(testPath)) throw new Error(`missing tests/test_outputs.py: ${testPath}`);

  const yaml = parseTaskYaml(readFileSync(yamlPath, "utf-8"));
  const testContent = readFileSync(testPath, "utf-8");

  if (!yaml.instruction || yaml.instruction.trim() === "") {
    throw new Error(`empty instruction for ${name}`);
  }

  const verifyScript = buildVerifyScript(rewritePaths(testContent));

  const taskMessage = [
    rewritePaths(yaml.instruction.trim()),
    "",
    "Note: you have a sandbox with bash, python3, vim, tmux. Your default cwd is /workspace — write all files under /workspace/ (no mkdir needed). Reply when fully done.",
  ].join("\n");

  const taskSet = {
    name: `tb-${name}`,
    version: "0.1.0",
    tasks: [
      {
        id: `tb-${name}`,
        description: `terminal-bench: ${name} (${yaml.category ?? "?"}, ${yaml.difficulty ?? "?"})`,
        message: taskMessage,
        reward: {
          type: "script" as const,
          verify_script: verifyScript,
          weights: { verifiable: 1.0, efficiency: 0 },
        },
        max_turns: 50,
        timeout_ms: Math.max(
          1_800_000,
          Math.round((yaml.max_agent_timeout_sec ?? 900) * 1000),
        ),
      },
    ],
  };

  const outPath = join(OUT_DIR, `${name}.json`);
  writeFileSync(outPath, JSON.stringify(taskSet, null, 2) + "\n");
  console.log(`wrote ${outPath}`);
}

function main() {
  const names = process.argv.slice(2);
  if (names.length === 0) {
    console.error("usage: tsx convert.ts <task-name> [<task-name>...]");
    process.exit(2);
  }
  for (const n of names) convertTask(n);
}

main();
