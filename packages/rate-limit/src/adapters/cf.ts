// CF Workers Rate Limiting binding wrapper.
//
// CF only supports period=10|60s and exposes only a binary success bit
// — no retryAfter. We plumb undefined when CF doesn't tell us.

import type { RateLimitConsumeResult, RateLimitGate, RateLimitGates } from "../index";

export interface CfRateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export class CfRateLimitGate implements RateLimitGate {
  constructor(private readonly binding: CfRateLimitBinding | undefined) {}

  async consume(key: string): Promise<RateLimitConsumeResult> {
    if (!this.binding) return { ok: true };
    try {
      const r = await this.binding.limit({ key });
      return { ok: r.success };
    } catch {
      // Binding very rarely errors; fail-open so observability never
      // breaks request handling. Same behavior as apps/main rate-limit.ts.
      return { ok: true };
    }
  }
}

/** Build the standard 5-bucket bundle from a CF env shape. Pass the
 *  whole env object — undefined bindings degrade to soft-pass via
 *  CfRateLimitGate's null check. */
export function gatesFromCfEnv(env: {
  RL_AUTH_IP?: CfRateLimitBinding;
  RL_AUTH_SEND_IP?: CfRateLimitBinding;
  RL_AUTH_SEND_EMAIL?: CfRateLimitBinding;
  RL_API_USER_WRITE?: CfRateLimitBinding;
  RL_SESSIONS_TENANT?: CfRateLimitBinding;
}): RateLimitGates {
  return {
    authIp: new CfRateLimitGate(env.RL_AUTH_IP),
    authSendIp: new CfRateLimitGate(env.RL_AUTH_SEND_IP),
    authSendEmail: new CfRateLimitGate(env.RL_AUTH_SEND_EMAIL),
    apiWrite: new CfRateLimitGate(env.RL_API_USER_WRITE),
    sessionsTenant: new CfRateLimitGate(env.RL_SESSIONS_TENANT),
  };
}
