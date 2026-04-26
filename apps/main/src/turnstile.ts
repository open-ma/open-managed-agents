// Cloudflare Turnstile token verification.
//
// Frontend renders a widget keyed by TURNSTILE_SITE_KEY (public) and gets
// back a single-use token. That token is sent on email-triggering /auth/*
// requests via the `cf-turnstile-token` header. Server side, this module
// posts the token to CF's siteverify with TURNSTILE_SECRET_KEY (private).
//
// Soft-fail behaviour: when TURNSTILE_SECRET_KEY is unset, verification
// is skipped — convenient during the deploy-then-configure window, and
// keeps dev/test working without a real CF site. Production should always
// have the secret set; the middleware logs a warn when it bypasses.

import { logWarn } from "@open-managed-agents/shared";

interface SiteVerifyResponse {
  success: boolean;
  "error-codes"?: string[];
  challenge_ts?: string;
  hostname?: string;
  action?: string;
  cdata?: string;
}

export interface TurnstileResult {
  /** True when the token was valid (or when verification is intentionally
   *  skipped because TURNSTILE_SECRET_KEY isn't configured). */
  ok: boolean;
  /** When ok=false, a short reason for logging / response body. */
  reason?: string;
  /** Whether the secret was missing (so we soft-passed). */
  skipped?: boolean;
}

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Verify a Turnstile token against CF's siteverify endpoint. Includes the
 * client IP as the optional `remoteip` field — CF cross-checks against
 * the IP that solved the challenge to detect token replay.
 */
export async function verifyTurnstile(
  secretKey: string | undefined,
  token: string | null | undefined,
  remoteIp: string,
): Promise<TurnstileResult> {
  if (!secretKey) {
    // Deploy-then-configure window: log so it's visible, but don't break.
    logWarn(
      { op: "turnstile.skipped" },
      "TURNSTILE_SECRET_KEY not set — Turnstile verification skipped",
    );
    return { ok: true, skipped: true };
  }
  if (!token || token.length < 10) {
    return { ok: false, reason: "missing or malformed turnstile token" };
  }

  const body = new URLSearchParams({
    secret: secretKey,
    response: token,
    remoteip: remoteIp,
  });

  let parsed: SiteVerifyResponse;
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    parsed = (await res.json()) as SiteVerifyResponse;
  } catch (err) {
    logWarn(
      { op: "turnstile.siteverify_fetch", err },
      "siteverify call failed — failing closed (rejecting request)",
    );
    return { ok: false, reason: "siteverify unreachable" };
  }

  if (!parsed.success) {
    return {
      ok: false,
      reason: (parsed["error-codes"] ?? ["unknown"]).join(","),
    };
  }
  return { ok: true };
}
