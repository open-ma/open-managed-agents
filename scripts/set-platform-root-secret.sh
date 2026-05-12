#!/usr/bin/env bash
#
# Set PLATFORM_ROOT_SECRET on every worker that needs it (main +
# integrations × staging + prod). Idempotent — re-runs overwrite with
# the same value.
#
# Three ways to provide the value, in priority order:
#   1. --key VALUE          (or --key=VALUE) — direct CLI arg.
#                           CAUTION: ends up in shell history. Mitigate with
#                           a leading space and HISTCONTROL=ignorespace, or
#                           clear history after.
#   2. PLATFORM_ROOT_SECRET env var
#   3. Interactive prompt (no echo, requires re-typing to confirm)
#
# Usage:
#   scripts/set-platform-root-secret.sh --key xxxxx               # all 4 targets
#   scripts/set-platform-root-secret.sh --key xxxxx --staging-only
#   scripts/set-platform-root-secret.sh --key xxxxx --prod-only
#   scripts/set-platform-root-secret.sh                           # interactive prompt
#   PLATFORM_ROOT_SECRET=xxx scripts/set-platform-root-secret.sh --yes
#
# After it succeeds:
#   1. `wrangler secret list ...` will show both PLATFORM_ROOT_SECRET and
#      MCP_SIGNING_KEY (legacy). They coexist until step 3.
#   2. Deploy the new code (which expects PLATFORM_ROOT_SECRET).
#   3. Verify, then `wrangler secret delete MCP_SIGNING_KEY` on the same 4
#      targets to clean up.
#
# Pre-req: cwd = repo root; wrangler installed and logged in (`wrangler whoami`).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# ── argument parsing ──
INCLUDE_STAGING=1
INCLUDE_PROD=1
SKIP_CONFIRM=0
KEY_FROM_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --staging-only) INCLUDE_PROD=0; shift ;;
    --prod-only)    INCLUDE_STAGING=0; shift ;;
    --yes|-y)       SKIP_CONFIRM=1; shift ;;
    --key)          KEY_FROM_ARG="${2:-}"; shift 2 ;;
    --key=*)        KEY_FROM_ARG="${1#*=}"; shift ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "unknown arg: $1 (use --help)" >&2
      exit 2
      ;;
  esac
done

# ── target list (config, env, label) ──
TARGETS=()
if [[ $INCLUDE_STAGING -eq 1 ]]; then
  TARGETS+=("apps/main/wrangler.jsonc:staging:main/staging")
  TARGETS+=("apps/integrations/wrangler.jsonc:staging:integrations/staging")
fi
if [[ $INCLUDE_PROD -eq 1 ]]; then
  TARGETS+=("apps/main/wrangler.jsonc::main/production")
  TARGETS+=("apps/integrations/wrangler.jsonc::integrations/production")
fi

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "no targets selected" >&2
  exit 2
fi

# ── obtain the secret value ──
# Priority: --key arg > PLATFORM_ROOT_SECRET env var > interactive prompt.
VALUE="${KEY_FROM_ARG:-${PLATFORM_ROOT_SECRET:-}}"
if [[ -z "$VALUE" ]]; then
  echo "Enter PLATFORM_ROOT_SECRET (input hidden, ENTER when done):"
  read -rs VALUE
  echo
  if [[ -z "$VALUE" ]]; then
    echo "empty value — aborting" >&2
    exit 1
  fi
  echo "Re-enter to confirm:"
  read -rs CONFIRM
  echo
  if [[ "$VALUE" != "$CONFIRM" ]]; then
    echo "values don't match — aborting" >&2
    exit 1
  fi
  unset CONFIRM
fi
unset KEY_FROM_ARG

# ── confirmation ──
echo
echo "Will set PLATFORM_ROOT_SECRET on:"
for t in "${TARGETS[@]}"; do
  IFS=':' read -r _config _env label <<<"$t"
  echo "  - $label"
done
echo
if [[ $SKIP_CONFIRM -eq 0 ]]; then
  read -rp "Proceed? [y/N] " ans
  if [[ "$ans" != "y" && "$ans" != "Y" ]]; then
    echo "aborted"
    exit 1
  fi
fi

# ── do the puts ──
SUCCESS=()
FAIL=()
for t in "${TARGETS[@]}"; do
  IFS=':' read -r config env label <<<"$t"
  # Always pass --env explicitly. Empty string ("") tells wrangler to target
  # the top-level (production) env rather than triggering the "multiple
  # environments defined, none specified" warning.
  cmd=(npx wrangler secret put PLATFORM_ROOT_SECRET --config "$config" --env="$env")
  echo
  echo "→ $label"
  if printf '%s' "$VALUE" | "${cmd[@]}"; then
    SUCCESS+=("$label")
  else
    FAIL+=("$label")
    echo "  FAILED — continuing with the rest, will report at end" >&2
  fi
done

# ── scrub the value from this shell ──
unset VALUE

# ── summary + verification hint ──
echo
echo "==== Summary ===="
echo "Set OK : ${#SUCCESS[@]}"
for s in "${SUCCESS[@]}"; do echo "  ✓ $s"; done
if [[ ${#FAIL[@]} -gt 0 ]]; then
  echo "Failed : ${#FAIL[@]}"
  for f in "${FAIL[@]}"; do echo "  ✗ $f"; done
  echo
  echo "Re-run for the failed targets after fixing the underlying issue."
  exit 3
fi

echo
echo "Verify each target shows PLATFORM_ROOT_SECRET:"
for t in "${TARGETS[@]}"; do
  IFS=':' read -r config env _label <<<"$t"
  echo "  npx wrangler secret list --config $config --env=\"$env\""
done
