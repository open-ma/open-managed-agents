// Cap CLI OAuth Device Authorization Grant routes.
//
// Distinct from /v1/oauth/* (which is browser Authorization Code + PKCE
// for MCP servers). Cap's flow is RFC 8628 — designed for CLIs that have
// no browser callback. The user gets a code + URL, visits it on any
// device, enters the code; we poll the upstream until ready.
//
//   client (console)        main worker          upstream OAuth
//        │                       │                       │
//        │ POST /initiate ─────► │ buildDeviceInitiate ─►│
//        │                       │ ◄─ device_code, user_code, …
//        │ ◄─ user_code, uri ─── │
//        │                       │                       │
//        │  user visits URL, enters code on github.com / etc
//        │                       │                       │
//        │ POST /poll ─────────► │ buildDevicePoll ────► │
//        │                       │ ◄─ pending / ready
//        │ ◄─ status ─────────── │
//        │   (loop until ready)  │
//        │                       │
//        │ on ready: main writes cap_cli credential to vault
//
// Auth: standard authMiddleware (logged-in user). Writes credential
// directly via services.credentials — same vault scope as the manual
// "+ Add CLI" form.

import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import { logWarn } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";
import {
  builtinSpecs,
  createSpecRegistry,
  buildDeviceInitiateRequest,
  parseDeviceInitiateResponse,
  buildDevicePollRequest,
  parseDevicePollResponse,
  type CapSpec,
  type DeviceFlowState,
  type HttpReqLike,
  type HttpResLike,
  type Clock,
} from "@open-managed-agents/cap";

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; services: Services };
}>();

const capRegistry = createSpecRegistry(builtinSpecs);
const clock: Clock = { nowMs: () => Date.now() };

// KV TTL for an in-flight device flow session — typical device codes
// expire in 15 min upstream; we match.
const DEVICE_FLOW_KV_TTL_SEC = 15 * 60;

interface DeviceFlowSession {
  readonly cli_id: string;
  readonly vault_id: string;
  readonly tenant_id: string;
  readonly state: DeviceFlowState;
}

// ─── POST /v1/cap-cli/oauth/initiate ─────────────────────────────────────

interface InitiateBody {
  vault_id: string;
  cli_id: string;
}

app.post("/initiate", async (c) => {
  const body = (await c.req.json()) as InitiateBody;
  if (!body.vault_id || !body.cli_id) {
    return c.json({ error: "vault_id, cli_id required" }, 400);
  }
  const tenantId = c.var.tenant_id;
  if (!tenantId) return c.json({ error: "no tenant" }, 401);

  if (!(await c.var.services.vaults.exists({ tenantId, vaultId: body.vault_id }))) {
    return c.json({ error: "vault not found" }, 404);
  }

  const spec = capRegistry.byCliId(body.cli_id);
  if (!spec) return c.json({ error: `unknown cli_id "${body.cli_id}"` }, 400);
  if (!spec.oauth?.device_flow) {
    return c.json(
      { error: `cli "${body.cli_id}" has no device flow registered — use manual token entry` },
      400,
    );
  }

  let state: DeviceFlowState;
  try {
    const initRes = await fetchHttp(buildDeviceInitiateRequest(spec));
    state = parseDeviceInitiateResponse(spec, initRes, clock);
  } catch (err) {
    logWarn({ cli_id: body.cli_id, err: (err as Error).message }, "cap-cli initiate failed");
    return c.json({ error: `upstream initiate failed: ${(err as Error).message}` }, 502);
  }

  const sessionId = randomSessionId();
  const session: DeviceFlowSession = {
    cli_id: body.cli_id,
    vault_id: body.vault_id,
    tenant_id: tenantId,
    state,
  };
  await c.env.CONFIG_KV.put(kvSessionKey(sessionId), JSON.stringify(session), {
    expirationTtl: DEVICE_FLOW_KV_TTL_SEC,
  });

  return c.json({
    session_id: sessionId,
    user_code: state.user_code,
    verification_uri: state.verification_uri,
    verification_uri_complete: state.verification_uri_complete,
    interval_seconds: state.interval_seconds,
    expires_at_ms: state.expires_at_ms,
  });
});

// ─── POST /v1/cap-cli/oauth/poll ─────────────────────────────────────────

interface PollBody {
  session_id: string;
}

app.post("/poll", async (c) => {
  const body = (await c.req.json()) as PollBody;
  if (!body.session_id) return c.json({ error: "session_id required" }, 400);
  const tenantId = c.var.tenant_id;
  if (!tenantId) return c.json({ error: "no tenant" }, 401);

  const raw = await c.env.CONFIG_KV.get(kvSessionKey(body.session_id));
  if (!raw) return c.json({ error: "device flow session not found or expired" }, 404);
  const session = JSON.parse(raw) as DeviceFlowSession;
  if (session.tenant_id !== tenantId) {
    return c.json({ error: "session does not belong to this tenant" }, 403);
  }

  const spec = capRegistry.byCliId(session.cli_id);
  if (!spec) return c.json({ error: `unknown cli_id "${session.cli_id}"` }, 500);

  let pollRes: HttpResLike;
  try {
    pollRes = await fetchHttp(buildDevicePollRequest(spec, session.state));
  } catch (err) {
    return c.json({ status: "error", oauth_error: "upstream_unreachable", description: (err as Error).message });
  }

  const result = parseDevicePollResponse(spec, pollRes, clock, session.state);

  switch (result.kind) {
    case "pending":
      return c.json({ status: "pending" });
    case "slow_down": {
      // Persist the new (longer) interval so subsequent polls respect it.
      const updated: DeviceFlowSession = {
        ...session,
        state: { ...session.state, interval_seconds: result.new_interval_seconds },
      };
      await c.env.CONFIG_KV.put(kvSessionKey(body.session_id), JSON.stringify(updated), {
        expirationTtl: DEVICE_FLOW_KV_TTL_SEC,
      });
      return c.json({ status: "slow_down", new_interval_seconds: result.new_interval_seconds });
    }
    case "expired":
      await c.env.CONFIG_KV.delete(kvSessionKey(body.session_id));
      return c.json({ status: "expired" });
    case "denied":
      await c.env.CONFIG_KV.delete(kvSessionKey(body.session_id));
      return c.json({ status: "denied" });
    case "error":
      await c.env.CONFIG_KV.delete(kvSessionKey(body.session_id));
      return c.json({ status: "error", oauth_error: result.oauth_error, description: result.description });
    case "ready": {
      // Write cap_cli credential into the vault. This is the only place
      // the access_token + refresh_token actually land in OMA storage.
      const auth = capCliAuthFromToken(session.cli_id, result.token);
      // Archive any existing non-archived cap_cli credentials in the same
      // vault that share the same cli_id. Without this, repeated re-auth
      // (user re-running the OAuth flow when a token went stale)
      // accumulates parallel rows; the proxy's resolver returned the
      // OLDEST match (created_at ASC) and silently kept injecting the
      // dead token. One non-archived row per (vault, cli_id) means the
      // resolver always sees the just-written one.
      try {
        const existing = await c.var.services.credentials.list({
          tenantId,
          vaultId: session.vault_id,
        });
        for (const ec of existing) {
          if (ec.archived_at) continue;
          const ea = (ec as unknown as { auth?: { type?: string; cli_id?: string } }).auth;
          if (ea?.type !== "cap_cli") continue;
          if (ea.cli_id !== session.cli_id) continue;
          await c.var.services.credentials.archive({
            tenantId,
            vaultId: session.vault_id,
            credentialId: (ec as { id: string }).id,
          });
        }
      } catch (err) {
        // Best-effort: don't fail the OAuth completion if the cleanup
        // sweep errors. Worst case the resolver fix below still picks
        // the newest non-archived match, so behavior stays correct.
        logWarn(
          { err: (err as Error).message, vault_id: session.vault_id, cli_id: session.cli_id },
          "cap-cli-oauth: archive prior cap_cli sweep failed; continuing",
        );
      }
      const cred = await c.var.services.credentials.create({
        tenantId,
        vaultId: session.vault_id,
        displayName: `${session.cli_id} (OAuth)`,
        auth,
      });
      await c.env.CONFIG_KV.delete(kvSessionKey(body.session_id));
      return c.json({ status: "ready", credential_id: cred.id });
    }
  }
});

// ─── helpers ─────────────────────────────────────────────────────────────

function kvSessionKey(sessionId: string): string {
  return `cap-cli-oauth:${sessionId}`;
}

function randomSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchHttp(req: HttpReqLike): Promise<HttpResLike> {
  const init: RequestInit = {
    method: req.method,
    headers: req.headers,
  };
  if (req.body !== null) init.body = req.body;
  const res = await fetch(req.url, init);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return {
    status: res.status,
    headers,
    body: await res.text(),
  };
}

function capCliAuthFromToken(
  cli_id: string,
  token: { token: string; expires_at?: number; extras?: Readonly<Record<string, string>> },
): import("@open-managed-agents/shared").CredentialAuth {
  const auth: import("@open-managed-agents/shared").CredentialAuth = {
    type: "cap_cli",
    cli_id,
    token: token.token,
  };
  if (token.expires_at !== undefined) {
    auth.expires_at = new Date(token.expires_at).toISOString();
  }
  if (token.extras) {
    if (typeof token.extras.refresh_token === "string") auth.refresh_token = token.extras.refresh_token;
    auth.extras = { ...token.extras };
  }
  return auth;
}

// Suppress TS "unused" for the spec import only used as a type hint.
export type { CapSpec };
export default app;
