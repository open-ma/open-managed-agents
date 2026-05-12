# Terminal-Bench 2.0 vs OMA harness

Pilot to surface OMA harness gaps by running [Terminal-Bench](https://github.com/laude-institute/terminal-bench) tasks against an OMA agent in a real sandbox. Reuses the existing `rl/` rollout pipeline, plus a `script` verifier added to `rl/verifier.ts`.

## Layout

```
rl/tasks/terminal-bench/
├── README.md           — this file
├── convert.ts          — TB task → RLTask JSON (idempotent)
├── tasks/              — generated RLTask JSONs (committed)
│   ├── hello-world.json
│   ├── sha-puzzle.json
│   ├── countdown-game.json
│   ├── aimo-airline-departures.json
│   └── grid-pattern-transform.json
├── tb-source/          — gitignored, shallow clone of terminal-bench
├── results/            — gitignored, JSONL output per run
└── findings-*.md       — pilot write-ups
```

## Pilot tasks (5)

Picked from `original-tasks/` for OMA-sandbox compatibility (no Docker-in-Docker, no GPU, no kernel modules) and minimal setup (no binary file copies, no build-time data generation):

| Task | Category | Why |
|---|---|---|
| `hello-world` | file-operations | Smoke test (almost certain pass) |
| `sha-puzzle` | games (crypto) | Creative + sha1 reasoning |
| `countdown-game` | mathematics | Search / arithmetic |
| `aimo-airline-departures` | mathematics | Modular arithmetic + write Python |
| `grid-pattern-transform` | software-engineering | Python module with algorithm |

## How to run

### Regenerate task JSONs (only if `tb-source/` updated)

```bash
# Clone TB once into tb-source/ (gitignored)
git clone --depth 1 https://github.com/laude-institute/terminal-bench.git \
  rl/tasks/terminal-bench/tb-source

# Convert
npx tsx rl/tasks/terminal-bench/convert.ts \
  hello-world sha-puzzle countdown-game aimo-airline-departures grid-pattern-transform
```

### Single-task pilot (smoke)

```bash
export OMA_API_URL=https://openma.dev
export OMA_API_KEY=$(python3 -c "import json; d=json.load(open('$HOME/.config/oma/credentials.json')); print(d['tenants'][d['active_tenant_id']]['token'])")
export RL_MODEL=<your-model>          # confirm against /v1/model_cards in your tenant
export RL_CONCURRENCY=1
export RL_TIMEOUT_MS=1800000        # 30 min/task
export RL_MAX_TURNS=50

npx tsx rl/cli.ts rollout \
  --tasks rl/tasks/terminal-bench/tasks/hello-world.json \
  --output rl/tasks/terminal-bench/results/smoke-hello-world.jsonl
```

### All 5 tasks

Same as above but point `--tasks` at the directory:

```bash
npx tsx rl/cli.ts rollout \
  --tasks rl/tasks/terminal-bench/tasks \
  --output rl/tasks/terminal-bench/results/pilot-$(date +%Y-%m-%d).jsonl
```

## How the script verifier works

Each generated task has `reward.type === "script"` with a `verify_script` that:

1. `mkdir -p /app/tests` and heredoc-injects the TB pytest test file
2. Installs pytest if not already present (`uv pip install --system pytest`, falling back to `pip3 --break-system-packages --user`)
3. Runs `python3 -m pytest -q tests/test_outputs.py` under `/app`

After the agent goes idle, `rl/rollout.ts:executeTask` calls `runScriptVerifier` (in `rl/verifier.ts`), which sends the script to the still-alive session as a follow-up turn and parses `EXIT_CODE=<n>` from the agent's reply. The result is stored on `trajectory.metadata.verifier_result`; `verify()` reads it and emits `script_pass` ∈ {0, 1}.

The verifier turn is bookkept separately and does not pollute the agent's `num_turns` count beyond what eventsToTrajectory captures.

## Inspecting results

The output JSONL has one trajectory per line. Quick inspection:

```bash
# Pass/fail summary
jq -r '"\(.task_id) reward=\(.reward.total) outcome=\(.outcome) turns=\(.num_turns) duration=\(.duration_ms)ms verifier_exit=\(.metadata.verifier_result.exit_code // "n/a")"' \
  rl/tasks/terminal-bench/results/pilot-*.jsonl

# Show verifier output for failures
jq -r 'select(.metadata.verifier_result.exit_code != 0) | "\n=== \(.task_id) ===\n\(.metadata.verifier_result.output)"' \
  rl/tasks/terminal-bench/results/pilot-*.jsonl
```

## Limitations / known caveats

- **Verifier turn is LLM-mediated**: the agent reports `EXIT_CODE=<n>`, parsed from its reply. If the model doesn't follow the format, exit code = -1 (treated as fail). Future improvement: bypass via direct sandbox exec endpoint (none exists yet on `apps/main`).
- **Setup files not used**: our 5 pilot tasks are self-contained instructions; for tasks that rely on Dockerfile `COPY` / `RUN` to set up state, the converter would need extending.
- **`/app/` workdir**: TB tasks expect `/app/`. OMA sandbox does not pre-create it; agent is told to `mkdir -p /app` in the message.
- **Costs**: with a Sonnet-class model ~ $0.5-3/task, 5-task run ≈ $5-15.

## Future expansion

- Convert more TB tasks (target the 89 in `terminal-bench-core` v2.0 set)
- Handle `RUN script.py && rm` build-time data generation (run generator as setup turn)
- Handle `COPY deps/` (read files from `tb-source/.../deps/` and bake into `setup_files`)
- If/when `apps/main/src/routes/sessions.ts` adds a raw `/sandbox/exec` endpoint, use it for verifier instead of LLM-mediated turn
