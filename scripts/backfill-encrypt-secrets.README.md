# Backfill: encrypt model card API keys and vault credentials

Operator runbook for `scripts/backfill-encrypt-secrets.ts`. Idempotent — the
script try-decrypts every row before writing, so a row that's already
encrypted under the current key is a no-op. Re-running is the recovery path
if a previous run was interrupted.

## What this fixes

`model_cards.api_key_cipher` and `credentials.auth` were stored as plaintext
prior to this PR despite their column names. The new runtime AES-256-GCM-only
build refuses any decrypt that fails the GCM tag check; this script rewrites
all existing rows in-place to the encrypted format.

## Required env / secrets

| | |
|---|---|
| `CF_ACCOUNT_ID` | Cloudflare account UUID |
| `CF_API_TOKEN` | API token with `D1: Edit` on every shard you'll touch |
| `PLATFORM_ROOT_SECRET` | Same value as the worker's `wrangler secret`. **Mismatch produces ciphertext the worker can't decrypt.** |

Cloudflare secrets are write-only — if you don't know the current
`PLATFORM_ROOT_SECRET` value, use the value you originally set when provisioning
the worker. If it's truly lost, the only path is to rotate the worker's
secret AND run this script with the new value (and accept that any
already-encrypted integration tokens become unreadable).

## Step-by-step cutover

### 1. Pre-flight (no impact)

Dry-run on every shard to surface row counts and any unparseable
`credentials.auth` JSON **before** going live:

```bash
for db in $(./scripts/list-shards.sh); do
  pnpm tsx scripts/backfill-encrypt-secrets.ts --db="$db" --dry-run
done
```

If validation reports rows that fail `JSON.parse`, investigate before
proceeding. Bad data needs to be fixed or deleted — encrypting garbage is a
one-way trip.

### 2. Deploy new code

`wrangler deploy` (or your usual pipeline). From this moment, every read of
plaintext rows in `model_cards.api_key_cipher` / `credentials.auth` returns a
500 from the relevant route. Affected paths:

- Agent worker model resolution (`/v1/model_cards/:id/key`)
- MCP proxy auth (`/v1/mcp-proxy/...`)
- OAuth refresh (writes still succeed — they overwrite with ciphertext, only
  reads of pre-existing rows fail)

### 3. Backfill in parallel

Run the script across every shard at maximum sustainable parallelism. Each
invocation handles one shard:

```bash
SHARDS=$(./scripts/list-shards.sh)
echo "$SHARDS" | xargs -P 8 -I {} \
  pnpm tsx scripts/backfill-encrypt-secrets.ts --db={} --shard={}
```

Tune `-P 8` based on Cloudflare API rate limits; 8–16 has been comfortable in
similar migrations.

### 4. Verify

Re-run with `--dry-run` for each shard:

```bash
for db in $(./scripts/list-shards.sh); do
  pnpm tsx scripts/backfill-encrypt-secrets.ts --db="$db" --dry-run
done
```

For every shard the summary must show `needsEncryption=0` for both
`model_cards.api_key_cipher` and `credentials.auth`. If any non-zero, re-run
the non-dry-run script for that shard.

## Recovery from interruption

The script try-decrypts every row before writing — a row already encrypted
under the current `PLATFORM_ROOT_SECRET` is detected and skipped. Re-running after
an interrupted attempt picks up exactly where the previous run stopped. No
risk of double-encrypting.

## Rollback

There is no clean rollback once the new code is deployed:

- Revert deploy → old code runs `identityCrypto`, treats ciphertext as
  plaintext, hands it to LLM providers / MCP servers, every request fails
  upstream.
- The new code refuses to start without `PLATFORM_ROOT_SECRET`, and refuses to
  decrypt anything that doesn't match the GCM tag.

The intended response to mid-backfill failure is **finish the backfill**, not
roll back. This is the cost of the single-step cutover the team chose.

## Errors

- **`PARSE failed: Unexpected token …`** — A `credentials.auth` row contains
  malformed JSON. Inspect with
  `wrangler d1 execute … --command "SELECT id, substr(auth, 1, 100) FROM credentials WHERE id = '…'"`.
  Either fix the JSON manually or `DELETE` the row (then revoke the
  corresponding upstream credential).
- **CF API 401 / 403** — Token missing `D1: Edit` on the target shard. Mint a
  scoped token rather than a global one for this operation.
- **Many "errors" in the per-row report after a partial run** — usually means
  one of the script's previous invocations encrypted with a *different*
  `PLATFORM_ROOT_SECRET`. Try-decrypt fails, then encrypt-and-write attempts to
  re-encrypt the existing ciphertext as if it were plaintext. Stop and
  reconcile which key the worker actually has before continuing.
