// OAuth Device Authorization Grant (RFC 8628) — pure builders + parsers.
//
// CAP doesn't perform any HTTP itself. The L4 driver:
//   1. fetches buildDeviceInitiateRequest(spec)
//   2. calls parseDeviceInitiateResponse(spec, response, clock) → DeviceFlowState
//   3. shows state.user_code + state.verification_uri to the user (e.g. via
//      Linear comment, Slack DM, terminal stdout, or web console toast)
//   4. polls in a loop:
//        sleep(state.interval_seconds * 1000)
//        fetch(buildDevicePollRequest(spec, state))
//        switch (parseDevicePollResponse(spec, response, clock, {interval_seconds})):
//          - "pending":     continue
//          - "slow_down":   bump state.interval_seconds, continue
//          - "ready":       call resolver.store(input, ready.token); break
//          - "expired" / "denied" / "error": surface to user
//
// RFC reference: https://datatracker.ietf.org/doc/html/rfc8628
//
// Supported upstream quirks: the spec.oauth.device_flow.request_headers
// field lets each CLI's spec opt into upstream-specific headers (GitHub
// returns form-urlencoded responses unless given Accept: application/json,
// so the gh spec sets it).

import type { CapSpec, HttpReqLike, HttpResLike } from "./types";
import type { Clock, ResolvedToken } from "./ports";

const FORM_CT = "application/x-www-form-urlencoded";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_INTERVAL = 5;
const SLOW_DOWN_BUMP = 5;

export interface DeviceFlowState {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  /** Pre-filled URL the user can visit on their phone — gh / google supply this. */
  readonly verification_uri_complete?: string;
  /** Polling cadence in seconds. May be increased by `slow_down` responses. */
  readonly interval_seconds: number;
  /** Unix ms when the device_code stops being valid. L4 should bail out past this. */
  readonly expires_at_ms: number;
}

export type DevicePollResult =
  | { readonly kind: "pending" }
  | { readonly kind: "slow_down"; readonly new_interval_seconds: number }
  | { readonly kind: "expired" }
  | { readonly kind: "denied" }
  | { readonly kind: "error"; readonly oauth_error: string; readonly description?: string }
  | { readonly kind: "ready"; readonly token: ResolvedToken };

// ─── Initiate ──────────────────────────────────────────────────────────────

export function buildDeviceInitiateRequest(spec: CapSpec): HttpReqLike {
  const df = requireDeviceFlow(spec);
  const params = new URLSearchParams();
  params.set("client_id", df.client_id);
  if (df.scopes.length > 0) params.set("scope", df.scopes.join(" "));

  return {
    url: df.initiate_url,
    method: "POST",
    headers: { "Content-Type": FORM_CT, ...(df.request_headers ?? {}) },
    body: encodeBody(params),
  };
}

export function parseDeviceInitiateResponse(
  _spec: CapSpec,
  res: HttpResLike,
  clock: Clock,
): DeviceFlowState {
  if (res.status !== 200) {
    throw new Error(`OAuth device initiate failed: status ${res.status}`);
  }
  const body = JSON.parse(res.body) as Record<string, unknown>;

  const device_code = requireString(body, "device_code");
  const user_code = requireString(body, "user_code");
  const verification_uri = requireString(body, "verification_uri");
  const expires_in = requireNumber(body, "expires_in");
  const interval_seconds =
    typeof body.interval === "number" ? body.interval : DEFAULT_INTERVAL;
  const verification_uri_complete =
    typeof body.verification_uri_complete === "string"
      ? body.verification_uri_complete
      : undefined;

  return {
    device_code,
    user_code,
    verification_uri,
    verification_uri_complete,
    interval_seconds,
    expires_at_ms: clock.nowMs() + expires_in * 1000,
  };
}

// ─── Poll ──────────────────────────────────────────────────────────────────

export function buildDevicePollRequest(
  spec: CapSpec,
  state: { device_code: string },
): HttpReqLike {
  const df = requireDeviceFlow(spec);
  const params = new URLSearchParams();
  params.set("client_id", df.client_id);
  params.set("device_code", state.device_code);
  params.set("grant_type", DEVICE_GRANT);

  return {
    url: df.token_url,
    method: "POST",
    headers: { "Content-Type": FORM_CT, ...(df.request_headers ?? {}) },
    body: encodeBody(params),
  };
}

export function parseDevicePollResponse(
  _spec: CapSpec,
  res: HttpResLike,
  clock: Clock,
  state: { interval_seconds: number },
): DevicePollResult {
  // Try to parse JSON. If it fails, surface as error rather than throw —
  // the L4 polling loop should be able to surface "transient upstream
  // glitch" without a try/catch around every poll.
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    return { kind: "error", oauth_error: "malformed_response" };
  }

  // Success path: 2xx with access_token.
  if (typeof body.access_token === "string" && body.access_token.length > 0) {
    const access_token = body.access_token;
    const expires_at =
      typeof body.expires_in === "number"
        ? clock.nowMs() + body.expires_in * 1000
        : undefined;
    const extras: Record<string, string> = {};
    if (typeof body.refresh_token === "string") extras.refresh_token = body.refresh_token;
    if (typeof body.token_type === "string") extras.token_type = body.token_type;

    const token: ResolvedToken = expires_at !== undefined
      ? { token: access_token, expires_at, ...(Object.keys(extras).length ? { extras } : {}) }
      : { token: access_token, ...(Object.keys(extras).length ? { extras } : {}) };
    return { kind: "ready", token };
  }

  const oauthError = typeof body.error === "string" ? body.error : undefined;
  const description =
    typeof body.error_description === "string" ? body.error_description : undefined;

  if (oauthError === "authorization_pending") return { kind: "pending" };
  if (oauthError === "slow_down") {
    return { kind: "slow_down", new_interval_seconds: state.interval_seconds + SLOW_DOWN_BUMP };
  }
  if (oauthError === "expired_token") return { kind: "expired" };
  if (oauthError === "access_denied") return { kind: "denied" };

  return {
    kind: "error",
    oauth_error: oauthError ?? `http_${res.status}`,
    ...(description !== undefined ? { description } : {}),
  };
}

// ─── helpers ───────────────────────────────────────────────────────────────

function requireDeviceFlow(spec: CapSpec) {
  const df = spec.oauth?.device_flow;
  if (!df) {
    throw new Error(
      `Spec "${spec.cli_id}" has no oauth.device_flow — cannot run device authorization flow`,
    );
  }
  return df;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`OAuth response missing required string field: ${key}`);
  }
  return v;
}

function requireNumber(body: Record<string, unknown>, key: string): number {
  const v = body[key];
  if (typeof v !== "number") {
    throw new Error(`OAuth response missing required number field: ${key}`);
  }
  return v;
}

function encodeBody(params: URLSearchParams): ArrayBuffer {
  return new TextEncoder().encode(params.toString()).buffer as ArrayBuffer;
}
