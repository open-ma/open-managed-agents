#!/usr/bin/env node
//
// scripts/lane-generate.mjs
//
// Generate per-lane wrangler configs that share prod data but use unique
// worker names. A "lane" is an ephemeral deploy of the same code base under
// a different worker name, intended for per-PR / per-feature parallel testing.
//
// What a lane GETS:
//   - Its own main + agent + integrations workers (code isolation)
//   - Its own DO storage (each worker's SESSION_DO is independent)
//
// What a lane SHARES with prod (intentional):
//   - CONFIG_KV namespace
//   - AUTH_DB / integrations D1
//   - All R2 buckets (FILES / WORKSPACE / BACKUP)
//   - Vectorize, AI, BROWSER, SEND_EMAIL bindings
//   - Analytics dataset (oma_events)
//   - Rate limit namespaces
//
// What gets STRIPPED on lane configs:
//   - routes (lanes use workers.dev URLs, no custom domain)
//   - env.* blocks (no staging override on a lane)
//   - triggers.crons (lanes must not run prod cron jobs against shared data)
//
// Usage:
//   node scripts/lane-generate.mjs <lane_name> [--check]
//
// Env:
//   CF_SUBDOMAIN — required to write the lane's INTEGRATIONS_ORIGIN var. If
//                  unset, a placeholder string is written and the script
//                  warns; deploy will not work until set.
//
// Output (idempotent — overwrites existing):
//   apps/main/wrangler.lane-<name>.jsonc
//   apps/agent/wrangler.lane-<name>.jsonc
//   apps/integrations/wrangler.lane-<name>.jsonc
//
// These are gitignored. After generation:
//   cd apps/main          && npx wrangler deploy --config wrangler.lane-<name>.jsonc
//   cd apps/agent         && npx wrangler deploy --config wrangler.lane-<name>.jsonc
//   cd apps/integrations  && npx wrangler deploy --config wrangler.lane-<name>.jsonc
//
// Secrets are NOT propagated by this script — copy them manually with
// `wrangler secret put` per lane worker, or extend deploy-lane.yml.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── 1. Parse args ───────────────────────────────────────────────────────────
const LANE = process.argv[2];
const CHECK_ONLY = process.argv.includes("--check");

if (!LANE) {
  console.error("Usage: lane-generate.mjs <lane_name> [--check]");
  process.exit(2);
}

// CF worker names: lowercase, alphanumeric + dashes, must start with letter/digit.
// We prefix with "managed-agents-lane-" / etc. so allow up to 30 chars here
// (leaves headroom under the 63-char CF limit).
if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(LANE)) {
  console.error(`Error: lane name '${LANE}' must match ^[a-z0-9][a-z0-9-]{1,30}$`);
  process.exit(2);
}

const SUBDOMAIN = process.env.CF_SUBDOMAIN || "";
if (!SUBDOMAIN) {
  console.warn(
    "WARN: CF_SUBDOMAIN env var not set — INTEGRATIONS_ORIGIN will use a placeholder.",
  );
  console.warn("      Set CF_SUBDOMAIN (your CF account workers.dev subdomain) before deploying.");
}

const NAMES = {
  main:         `managed-agents-lane-${LANE}`,
  agent:        `sandbox-default-lane-${LANE}`,
  integrations: `managed-agents-integrations-lane-${LANE}`,
};

const INT_ORIGIN = SUBDOMAIN
  ? `https://${NAMES.integrations}.${SUBDOMAIN}.workers.dev`
  : `https://${NAMES.integrations}.<CF_SUBDOMAIN>.workers.dev`;

const MAIN_URL = SUBDOMAIN
  ? `https://${NAMES.main}.${SUBDOMAIN}.workers.dev`
  : `https://${NAMES.main}.<CF_SUBDOMAIN>.workers.dev`;

// ── 2. JSONC reader ─────────────────────────────────────────────────────────
// Strips // and /* */ comments without disturbing string contents. Tiny state
// machine — handles \" escapes inside strings so URLs / paths are preserved.
function stripJsonc(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '"') {
      out += c; i++;
      while (i < src.length) {
        const ch = src[i];
        out += ch; i++;
        if (ch === "\\") { out += src[i]; i++; continue; }
        if (ch === '"') break;
      }
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c; i++;
  }
  return out;
}

function readWrangler(relPath) {
  const abs = join(ROOT, relPath);
  const raw = readFileSync(abs, "utf8");
  try {
    return JSON.parse(stripJsonc(raw));
  } catch (err) {
    throw new Error(`Failed to parse ${relPath}: ${err.message}`);
  }
}

function writeJson(relPath, obj) {
  const abs = join(ROOT, relPath);
  if (CHECK_ONLY) {
    console.log(`[check] would write ${relPath} (${JSON.stringify(obj).length} bytes)`);
    return;
  }
  writeFileSync(abs, JSON.stringify(obj, null, 2) + "\n");
}

// ── 3. Build main lane config ───────────────────────────────────────────────
const main = readWrangler("apps/main/wrangler.jsonc");
main.name = NAMES.main;
delete main.routes;
delete main.triggers; // no cron on lanes — would run against shared prod data
delete main.env;      // no staging override on a lane
main.vars = {
  ...(main.vars || {}),
  // Linear / GitHub / Slack OAuth callbacks land here; must be the lane's
  // own integrations worker, not prod's.
  INTEGRATIONS_ORIGIN: INT_ORIGIN,
};
main.services = [
  { binding: "SANDBOX_sandbox_default", service: NAMES.agent },
  { binding: "INTEGRATIONS",            service: NAMES.integrations },
];
writeJson(`apps/main/wrangler.lane-${LANE}.jsonc`, main);

// ── 4. Build agent lane config ──────────────────────────────────────────────
const agent = readWrangler("apps/agent/wrangler.jsonc");
agent.name = NAMES.agent;
delete agent.routes;
delete agent.triggers;
delete agent.env;
agent.services = [
  { binding: "INTEGRATIONS", service: NAMES.integrations },
];
writeJson(`apps/agent/wrangler.lane-${LANE}.jsonc`, agent);

// ── 5. Build integrations lane config ───────────────────────────────────────
const integrations = readWrangler("apps/integrations/wrangler.jsonc");
integrations.name = NAMES.integrations;
delete integrations.routes;
delete integrations.env;
integrations.vars = {
  ...(integrations.vars || {}),
  GATEWAY_ORIGIN: INT_ORIGIN,
};
integrations.services = [
  { binding: "MAIN", service: NAMES.main },
];
writeJson(`apps/integrations/wrangler.lane-${LANE}.jsonc`, integrations);

// ── 6. Summary ──────────────────────────────────────────────────────────────
const tag = CHECK_ONLY ? "[check]" : "Generated";
console.log(`${tag} lane '${LANE}' configs:`);
console.log(`  apps/main/wrangler.lane-${LANE}.jsonc          (${NAMES.main})`);
console.log(`  apps/agent/wrangler.lane-${LANE}.jsonc         (${NAMES.agent})`);
console.log(`  apps/integrations/wrangler.lane-${LANE}.jsonc  (${NAMES.integrations})`);
console.log("");
console.log("URLs (after deploy):");
console.log(`  main:         ${MAIN_URL}`);
console.log(`  integrations: ${INT_ORIGIN}`);
console.log("");
console.log("Deploy (must be in this order so service bindings resolve):");
console.log(`  1. cd apps/integrations && npx wrangler deploy --config wrangler.lane-${LANE}.jsonc`);
console.log(`  2. cd apps/agent        && npx wrangler deploy --config wrangler.lane-${LANE}.jsonc`);
console.log(`  3. cd apps/main         && npx wrangler deploy --config wrangler.lane-${LANE}.jsonc`);
console.log("");
console.log("Tear down: gh workflow run teardown-lane.yml -F lane_name=" + LANE);
