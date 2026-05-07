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

/**
 * Translate a terminal-bench task Dockerfile into a `setup_script` that
 * runs in our sandbox via /exec before the agent's first message. We
 * extract RUN, WORKDIR, ENV, and COPY directives — everything else
 * (FROM, comments, build args) is dropped because:
 *   - FROM is moot: we run inside our own openma/sandbox-base image
 *   - comments and benchmark canary strings have no runtime semantics
 *
 * Skips RUN commands that install packages our base image already provides
 * (git, tmux, asciinema) — saves a few seconds and avoids apt cache misses
 * in the sandbox container.
 *
 * Translates /app paths to /workspace via the existing rewritePaths to
 * keep everything inside the persistence boundary (only /workspace is
 * snapshotted by createBackup).
 *
 * COPY <src> <dst> is rendered as a heredoc that writes the source file
 * content into <dst>. Source paths are resolved relative to taskDir.
 *
 * Returns undefined if the resulting script is empty (no executable
 * directives — pure FROM-only Dockerfile, e.g. tasks that don't need
 * any pre-staging beyond the base image).
 */
function dockerfileToSetupScript(dockerfile: string, taskDir: string): string | undefined {
  // Pre-pass: handle backslash line continuations the way Docker does.
  const physicalLines = dockerfile.split(/\r?\n/);
  const logical: string[] = [];
  let buf = "";
  for (const raw of physicalLines) {
    if (/^\s*#/.test(raw) || raw.trim() === "") {
      if (buf) { logical.push(buf); buf = ""; }
      continue;
    }
    if (raw.endsWith("\\")) {
      buf += raw.slice(0, -1);
    } else {
      buf += raw;
      logical.push(buf);
      buf = "";
    }
  }
  if (buf) logical.push(buf);

  // Packages already in openma/sandbox-base — skip RUN apt-get install
  // lines whose payload is exactly these (a common no-op in TB tasks).
  const BASE_HAS = new Set(["git", "tmux", "asciinema", "curl", "wget", "vim", "jq"]);

  let cwd = "/";
  const lines: string[] = [
    "set -euo pipefail",
    "# Auto-generated from terminal-bench Dockerfile by rl/tasks/terminal-bench/convert.ts",
    "",
  ];
  for (const lineRaw of logical) {
    const line = lineRaw.trim();
    const m = /^([A-Z]+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, op, rest] = m;
    switch (op) {
      case "FROM":
      case "MAINTAINER":
      case "LABEL":
      case "ARG":
      case "VOLUME":
      case "EXPOSE":
      case "USER":
      case "CMD":
      case "ENTRYPOINT":
      case "HEALTHCHECK":
      case "STOPSIGNAL":
      case "ONBUILD":
      case "SHELL":
        // Image-build / runtime config; not applicable when running inside
        // an existing container.
        break;
      case "WORKDIR": {
        cwd = rewritePaths(rest.replace(/^["']|["']$/g, ""));
        lines.push(`mkdir -p ${shellQuoteArg(cwd)} && cd ${shellQuoteArg(cwd)}`);
        break;
      }
      case "ENV": {
        // ENV KEY=value or ENV KEY value
        const env = parseEnvLine(rest);
        for (const [k, v] of env) {
          lines.push(`export ${k}=${shellQuoteArg(rewritePaths(v))}`);
        }
        break;
      }
      case "RUN": {
        const cmd = rewritePaths(rest);
        if (isInstallNoop(cmd, BASE_HAS)) {
          lines.push(`# skipped (base image has it): ${cmd.slice(0, 80)}`);
          break;
        }
        lines.push(cmd);
        break;
      }
      case "COPY":
      case "ADD": {
        // Best-effort: read the source file from taskDir and embed via
        // heredoc. Wildcards / multi-source COPY isn't supported — the
        // converter throws so the operator can fix the Dockerfile or
        // hand-author the setup_script.
        const parts = rest.split(/\s+/).filter(Boolean);
        if (parts.length !== 2) {
          throw new Error(
            `convert.ts COPY/ADD with !=2 args not supported: \`${rest}\` (taskDir=${taskDir})`,
          );
        }
        const [src, dstRaw] = parts;
        const dst = rewritePaths(dstRaw);
        const srcPath = join(taskDir, src);
        if (!existsSync(srcPath)) {
          throw new Error(`COPY source missing: ${srcPath}`);
        }
        const content = readFileSync(srcPath, "utf-8");
        const sentinel = `OMA_DOCKERCOPY_${Math.random().toString(16).slice(2, 14).toUpperCase()}`;
        if (content.includes(sentinel)) {
          throw new Error(`COPY heredoc sentinel collision for ${srcPath}`);
        }
        const lastSlash = dst.lastIndexOf("/");
        const dir = lastSlash > 0 ? dst.slice(0, lastSlash) : "/";
        lines.push(`mkdir -p ${shellQuoteArg(dir)}`);
        lines.push(`cat > ${shellQuoteArg(dst)} <<'${sentinel}'`);
        lines.push(content);
        lines.push(sentinel);
        break;
      }
      default:
        throw new Error(`convert.ts: unhandled Dockerfile directive ${op}: ${rest.slice(0, 80)}`);
    }
  }

  // Drop the trailing 3 boilerplate lines (set -euo pipefail + comment + blank)
  // if nothing else got appended.
  if (lines.length === 3) return undefined;
  return lines.join("\n") + "\n";
}

function shellQuoteArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function parseEnvLine(rest: string): [string, string][] {
  // Two forms: `KEY=value [KEY2=value2 ...]` or legacy `KEY value`
  if (!rest.includes("=") || /^\S+\s+\S/.test(rest) && !/=/.test(rest.split(/\s/)[0])) {
    const sp = rest.indexOf(" ");
    return [[rest.slice(0, sp), rest.slice(sp + 1)]];
  }
  // Naive split — sufficient for terminal-bench corpus, doesn't handle quoted
  // values with spaces. Throws so we notice if a task needs richer parsing.
  const out: [string, string][] = [];
  for (const tok of rest.split(/\s+/)) {
    const eq = tok.indexOf("=");
    if (eq < 0) {
      throw new Error(`ENV token without '=': "${tok}" in "${rest}"`);
    }
    out.push([tok.slice(0, eq), tok.slice(eq + 1)]);
  }
  return out;
}

function isInstallNoop(cmd: string, baseHas: Set<string>): boolean {
  // Match `apt-get install` (with -y / --no-install-recommends / --yes etc)
  // and check whether every package in the install list is in baseHas.
  const m = /apt-get\s+(?:-\S+\s+)*update(?:\s*&&\s*apt-get\s+(?:-\S+\s+)*install\s+([^\n;|&]+))?/.exec(cmd);
  if (!m || !m[1]) return false;
  const args = m[1].split(/\s+/).filter(Boolean);
  // Drop apt-get flags
  const pkgs = args.filter(a => !a.startsWith("-"));
  if (pkgs.length === 0) return false;
  return pkgs.every(p => baseHas.has(p));
}

function convertTask(name: string) {
  const taskDir = join(TB_SOURCE, name);
  if (!existsSync(taskDir)) {
    throw new Error(`task dir not found: ${taskDir}`);
  }
  const yamlPath = join(taskDir, "task.yaml");
  const testPath = join(taskDir, "tests", "test_outputs.py");
  const dockerfilePath = join(taskDir, "Dockerfile");
  const runTestsPath = join(taskDir, "run-tests.sh");
  if (!existsSync(yamlPath)) throw new Error(`missing task.yaml: ${yamlPath}`);

  const yaml = parseTaskYaml(readFileSync(yamlPath, "utf-8"));
  if (!yaml.instruction || yaml.instruction.trim() === "") {
    throw new Error(`empty instruction for ${name}`);
  }

  // Two verifier shapes are common in terminal-bench:
  //   (a) tests/test_outputs.py — pytest written by the task author, embedded
  //       via heredoc in our verify_script
  //   (b) run-tests.sh — bash that does its own setup + invokes pytest (used
  //       by swe-bench-* style tasks). We embed the script verbatim and
  //       trust its exit code.
  // (a) wins if both exist, since it's the more recent convention.
  let verifyScript: string;
  if (existsSync(testPath)) {
    const testContent = readFileSync(testPath, "utf-8");
    verifyScript = buildVerifyScript(rewritePaths(testContent));
  } else if (existsSync(runTestsPath)) {
    const runTests = readFileSync(runTestsPath, "utf-8");
    verifyScript = rewritePaths(runTests);
  } else {
    throw new Error(`no verifier found: expected tests/test_outputs.py or run-tests.sh in ${taskDir}`);
  }

  // Dockerfile setup → setup_script. Extract RUN / WORKDIR / ENV / COPY
  // and translate to a bash script the eval-runner runs in /exec before
  // the agent's first message. Skipped if no Dockerfile (legacy tasks).
  let setupScript: string | undefined;
  if (existsSync(dockerfilePath)) {
    const dockerfile = readFileSync(dockerfilePath, "utf-8");
    setupScript = dockerfileToSetupScript(dockerfile, taskDir);
  }

  const verifyScriptFinal = verifyScript;

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
        ...(setupScript ? { setup_script: setupScript } : {}),
        reward: {
          type: "script" as const,
          verify_script: verifyScriptFinal,
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
