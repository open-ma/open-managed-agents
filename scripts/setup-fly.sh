#!/usr/bin/env bash
set -euo pipefail

if ! command -v fly >/dev/null 2>&1; then
  echo "flyctl is required: https://fly.io/docs/flyctl/install/" >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to generate OpenMA application secrets locally" >&2
  exit 1
fi

data_mode="${OPENMA_FLY_DATA_MODE:-sqlite}"
if [[ "$data_mode" != "sqlite" && "$data_mode" != "postgres" ]]; then
  echo "OPENMA_FLY_DATA_MODE must be sqlite or postgres" >&2
  exit 1
fi

sandbox_provider="${OPENMA_FLY_SANDBOX_PROVIDER:-}"
sandbox_provider="${sandbox_provider#"${sandbox_provider%%[![:space:]]*}"}"
sandbox_provider="${sandbox_provider%"${sandbox_provider##*[![:space:]]}"}"
sandbox_provider="$(printf '%s' "$sandbox_provider" | tr '[:upper:]' '[:lower:]')"
if [[ -z "$sandbox_provider" ]]; then
  echo "OPENMA_FLY_SANDBOX_PROVIDER is required; choose an isolated provider such as e2b, daytona, or boxrun" >&2
  exit 1
fi
if [[ "$sandbox_provider" == "subprocess" ]]; then
  echo "subprocess is test-only and cannot be deployed as a Fly sandbox provider" >&2
  exit 1
fi

emit_provider_configuration() {
  case "$sandbox_provider" in
    e2b)
      if [[ -z "${E2B_API_KEY:-}" ]]; then
        echo "E2B_API_KEY is required when OPENMA_FLY_SANDBOX_PROVIDER=e2b" >&2
        return 1
      fi
      printf 'E2B_API_KEY=%s\n' "$E2B_API_KEY"
      [[ -z "${E2B_API_URL:-}" ]] || printf 'E2B_API_URL=%s\n' "$E2B_API_URL"
      [[ -z "${E2B_SANDBOX_URL:-}" ]] || printf 'E2B_SANDBOX_URL=%s\n' "$E2B_SANDBOX_URL"
      [[ -z "${E2B_DOMAIN:-}" ]] || printf 'E2B_DOMAIN=%s\n' "$E2B_DOMAIN"
      ;;
    daytona)
      if [[ -z "${DAYTONA_API_KEY:-}" ]]; then
        echo "DAYTONA_API_KEY is required when OPENMA_FLY_SANDBOX_PROVIDER=daytona" >&2
        return 1
      fi
      printf 'DAYTONA_API_KEY=%s\n' "$DAYTONA_API_KEY"
      [[ -z "${DAYTONA_API_URL:-}" ]] || printf 'DAYTONA_API_URL=%s\n' "$DAYTONA_API_URL"
      ;;
    boxrun)
      if [[ -z "${BOXRUN_URL:-}" ]]; then
        echo "BOXRUN_URL is required when OPENMA_FLY_SANDBOX_PROVIDER=boxrun" >&2
        return 1
      fi
      printf 'BOXRUN_URL=%s\n' "$BOXRUN_URL"
      [[ -z "${BOXRUN_TOKEN:-}" ]] || printf 'BOXRUN_TOKEN=%s\n' "$BOXRUN_TOKEN"
      ;;
    *)
      echo "OPENMA_FLY_SANDBOX_PROVIDER must be e2b, daytona, or boxrun" >&2
      return 1
      ;;
  esac
}

# Validate provider-specific configuration before creating or changing a Fly app.
emit_provider_configuration >/dev/null

build_from_source="${OPENMA_FLY_BUILD_FROM_SOURCE:-0}"
if [[ "$build_from_source" != "0" && "$build_from_source" != "1" ]]; then
  echo "OPENMA_FLY_BUILD_FROM_SOURCE must be 0 or 1" >&2
  exit 1
fi
if [[ "$build_from_source" == "1" && -n "${OPENMA_FLY_IMAGE:-}" ]]; then
  echo "OPENMA_FLY_IMAGE and OPENMA_FLY_BUILD_FROM_SOURCE=1 are mutually exclusive" >&2
  exit 1
fi

release_image="${OPENMA_FLY_IMAGE:-}"
if [[ "$build_from_source" != "1" ]]; then
  if [[ -z "$release_image" ]]; then
    if ! command -v git >/dev/null 2>&1; then
      echo "git is required to resolve the OpenMA release checkpoint; alternatively set OPENMA_FLY_IMAGE to a digest-pinned image" >&2
      exit 1
    fi
    release_sha="$(git rev-parse --verify HEAD 2>/dev/null || true)"
    if [[ ! "$release_sha" =~ ^[0-9a-f]{40}$ ]]; then
      echo "Could not resolve a full Git release checkpoint; set OPENMA_FLY_IMAGE to an immutable image" >&2
      exit 1
    fi
    release_image="ghcr.io/openma-ai/open-managed-agents:sha-${release_sha}"
  fi

  if [[ ! "$release_image" =~ @sha256:[0-9a-f]{64}$ && ! "$release_image" =~ :sha-[0-9a-f]{40}$ ]]; then
    echo "OPENMA_FLY_IMAGE must identify an immutable release image by sha256 digest or full sha-<git-sha> tag" >&2
    exit 1
  fi
fi

fly auth whoami >/dev/null

new_app=0
if ! fly status --json >/dev/null 2>&1; then
  new_app=1
  launch_args=(launch --copy-config --no-deploy --ha=false)
  if [[ "$data_mode" == "postgres" ]]; then
    launch_args+=(--db mpg)
  fi
  fly "${launch_args[@]}"
fi

better_auth_secret=""
platform_root_secret=""
if [[ "$new_app" == "1" ]]; then
  better_auth_secret="$(openssl rand -hex 32)"
  platform_root_secret="$(openssl rand -hex 32)"
fi

{
  if [[ "$new_app" == "1" ]]; then
    printf 'BETTER_AUTH_SECRET=%s\nPLATFORM_ROOT_SECRET=%s\n' \
      "$better_auth_secret" "$platform_root_secret"
  fi
  printf 'SANDBOX_PROVIDER=%s\n' "$sandbox_provider"
  emit_provider_configuration
} | fly secrets import --stage >/dev/null
unset better_auth_secret platform_root_secret

if [[ "$new_app" != "1" ]]; then
  echo "Using the existing Fly app; application secrets are left unchanged."
fi

if [[ "$build_from_source" == "1" ]]; then
  echo "Building the Fly image from the local checkout (development mode)."
  fly deploy --strategy rolling
else
  echo "Deploying OpenMA release checkpoint: ${release_image}"
  fly deploy --image "$release_image" --strategy rolling
fi
fly checks list
