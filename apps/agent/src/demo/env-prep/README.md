# env-prep demo — DO-owned base_snapshot prep

**Status**: demo only, not wired to wrangler. Lives in `apps/agent/src/demo/`
to make that explicit.

## What this is

Resurrects the env-images / base_snapshot path that was killed in
`02d7d2d` + `7ba6856` (2026-04-28). Uses lessons learned from the
/workspace backup feature (commits `b6eb5c1`, `118c7f2`, `29f8803`,
2026-05-04) plus the keepAlive / sandbox.exec / async-kickoff tricks
that already worked at the time but were tried piecemeal.

## Architecture

```
┌─ env create / refresh ──┐                ┌─ user session warmup ─┐
│  POST /v1/environments  │                │ getSandbox(sessionId) │
│                         │                │ resolveEnvHandle()    │
│  resolveEnvHandle()     │                │   D1 fast path  ──┐   │
│    → stub.beginPrep()   │                │   stub.pollPrep() │   │
│      returns 202        │                │ if ready:         │   │
└─────────┬───────────────┘                │   applyEnvHandle  │   │
          │ DO RPC                         │     restoreBackup │   │
          ▼                                │ if not_ready:     │   │
┌─ EnvPrepSandbox DO (per envId) ────────┐ │   error / wait    │   │
│  sleepAfter = 30m, keepAlive on exec   │ └────────┬──────────┘   │
│  state machine in DO storage:          │          │              │
│    idle → building → ready / failed    │          │ presigned    │
│  runPrep(strategy, attempt):           │          │ R2 GET via   │
│    1. sandbox.exec(installScript)      │          │ restoreBackup│
│       (HTTP to container — no SDK lock)│          ▼              │
│    2. test -f /tmp/.prep-done          │  ┌─ user OmaSandbox ──┐ │
│    3. createBackup(cacheDir) → R2      │  │ /home/env-cache/X/ │ │
│    4. write handle to DO storage       │  │ ready to exec      │ │
│  heartbeat ticker every 15s            │  └────────────────────┘ │
│  retry 3× on transient errors          │                         │
│  stale-heartbeat detection             │                         │
└─────────┬──────────────────────────────┘                         │
          │ ANALYTICS / D1 mirror                                  │
          └─→ env_prep_mirror table for cross-worker fast lookup ──┘
```

## Why this can work where the original couldn't

| Original failure | Now fixed by |
|---|---|
| SDK `createBackup` hits 10–15s `blockConcurrencyWhile` cap | Install runs as `sandbox.exec` (HTTP request, not DO method). Snapshot still uses SDK but `/home/env-cache` after pip install is squashfs-friendly (already-extracted wheels) and typically <50MB → fits in cap. For >100MB, drop-in replace with shell-tar + presigned-R2-PUT (commit e80a5c3). |
| Container died mid-install (no keepAlive) | `keepAlive: true` is implicit because the prep DO IS the container's host DO. `sleepAfter = 30m` covers worst-case install. |
| Multiple SessionDOs racing on same fresh env | Single-flight by DO identity: `getEnvPrepSandbox(envId)` always returns the same DO. `beginPrep()` coalesces concurrent calls via the state machine. |
| Lazy-prep blocked user's first turn | Async kickoff: `beginPrep()` returns 202 immediately, `pollPrep()` is cheap. User-facing SessionDO doesn't wait. |
| R2 squashfs corrupted by MITM credential injection | `interceptHttps = false` on the prep DO (no vault creds needed for pip / npm). On user side, `outboundByHost` R2 bypass (commit 118c7f2) is already in place. |
| "Cron + kickoff" coordination was complex (commit caf270e ripped it out) | No external coordinator. Heartbeat lives in DO storage; stale-heartbeat detection is internal to the DO. |
| Zombie SessionDOs hammered the container pool on retry | Retry loop is INSIDE EnvPrepSandbox, scoped to one DO + one container slot. User-facing SessionDOs only read state. |

## Wrangler binding (sketch — not applied)

In `apps/agent/wrangler.jsonc` you'd add:

```jsonc
"containers": [
  { "class_name": "Sandbox",        "image": "./Dockerfile.sandbox",     "instance_type": "standard-1", "max_instances": 50 },
  { "class_name": "EnvPrepSandbox", "image": "./Dockerfile.env-prep",    "instance_type": "standard-2", "max_instances": 10 }
],
"durable_objects": {
  "bindings": [
    { "name": "SESSION_DO", "class_name": "SessionDO" },
    { "name": "SANDBOX",    "class_name": "Sandbox" },
    { "name": "ENV_PREP",   "class_name": "EnvPrepSandbox" }
  ]
},
"migrations": [
  { "tag": "v2", "new_sqlite_classes": ["EnvPrepSandbox"] }
]
```

And export from `apps/agent/src/index.ts`:

```ts
export { EnvPrepSandbox } from "./demo/env-prep/env-prep-sandbox";
```

## Things deliberately punted on

- **D1 mirror writer**. `restore-helper.ts` reads from `env_prep_mirror`
  but no one writes it yet. Production: `runPrep` calls `env.MAIN.recordEnvPrepReady(envId, handle)` after success. Demo skips so it's a single-file read.
- **Tenant scoping**. DO key is `env-prep:${envId}` — production should
  be `env-prep:${tenantId}:${envId}` so two tenants can't poison each
  other's env handle.
- **TTL / GC**. The `30 * 24 * 3600` TTL on the snapshot is hardcoded;
  no cron prunes stale `env_prep_mirror` rows.
- **Image size**. The wrangler sketch shows a separate
  `Dockerfile.env-prep` — in practice you'd reuse `Dockerfile.sandbox`
  and just pre-bake `pip` / `npm` / `cargo` / `uv` so the install script
  has them. Smaller scope = faster prep = fewer retries.

## Testing this end-to-end (when wired)

```bash
# 1. Trigger prep
curl -X POST https://agent.../v1/internal/env-prep \
  -d '{"envId": "test-pandas", "installScript": "pip install pandas==2.2.0", "cacheDir": "/home/env-cache/test-pandas"}'
# → {"accepted": true, "state": {"status": "building", ...}}

# 2. Poll
curl https://agent.../v1/internal/env-prep/test-pandas
# → {"status": "building", ...}  (after ~30s)
# → {"status": "ready",    ...}  (after ~60s)

# 3. Check DO logs in CF dashboard for [env-prep] traces.

# 4. Spawn a user session in the same env, observe restoreBackup applies
#    the handle and `python -c "import pandas"` works in 0 install time.
```

## Failure-mode checklist (what the demo handles)

- [x] Install script exits non-zero → state → failed, attempts++, surface to caller
- [x] Container dies mid-install (transient) → auto-retry up to 3×
- [x] Multiple beginPrep() calls in flight → coalesce on existing run
- [x] keepAlive somehow fails + heartbeat goes stale (>90s) → next caller restarts
- [x] Caller reads stale state during restart window → sees `status: building` (correct)
- [ ] DO migrates host mid-prep → state survives (DO storage is durable), but in-flight Promise is lost. Next poll sees stale heartbeat → restart. (Tested only logically.)
- [ ] R2 PUT fails on snapshot → currently bubbles as failed. Could split snapshot retry from install retry.
- [ ] Disk fills up → install fails, surfaced as failed. No cleanup. (Caller's responsibility for now.)
