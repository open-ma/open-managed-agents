// Regression tests for the /admin/* gate added in ultrareview bug_006.
//
// The gate is an isStagingEnv() check based on GATEWAY_ORIGIN. A prod env
// that accidentally inherits TEMP_DEBUG_TOKEN must still return 404 — the
// shared-secret was the only protection before, and a prod leak would
// expose Linear bot OAuth tokens.

import { describe, it, expect } from "vitest";
import app from "../../apps/integrations/src/index";

const ADMIN_PATHS = [
  "/admin/dump-linear-installation-token?installation_id=any",
  "/admin/linear-reauth-link?installation_id=any",
];

function envWith(opts: { gatewayOrigin: string; debugToken?: string | undefined }) {
  return {
    GATEWAY_ORIGIN: opts.gatewayOrigin,
    TEMP_DEBUG_TOKEN: opts.debugToken,
    // P0 boot-guard: buildProviders constructs WebCryptoAesGcm at request
    // time and throws on empty secret. Set a stable test value so the
    // admin-gate router can run and return its real status.
    PLATFORM_ROOT_SECRET: "test-platform-root-secret-padded-to-thirtytwo",
    // Other Env fields the routes never read on the early-return paths.
  } as unknown as Parameters<(typeof app)["fetch"]>[1];
}

describe("/admin gate (ultrareview bug_006)", () => {
  for (const path of ADMIN_PATHS) {
    describe(path, () => {
      it("404s in prod env even with the right TEMP_DEBUG_TOKEN", async () => {
        const env = envWith({
          gatewayOrigin: "https://integrations.openma.dev",
          debugToken: "right-token",
        });
        const res = await app.fetch(
          new Request("https://example.com" + path, {
            headers: { "x-debug-token": "right-token" },
          }),
          env,
        );
        expect(res.status).toBe(404);
      });

      it("404s in prod env even when TEMP_DEBUG_TOKEN is unset", async () => {
        const env = envWith({ gatewayOrigin: "https://integrations.openma.dev" });
        const res = await app.fetch(
          new Request("https://example.com" + path),
          env,
        );
        expect(res.status).toBe(404);
      });

      it("401s in staging env when token is wrong", async () => {
        const env = envWith({
          gatewayOrigin: "https://managed-agents-integrations-staging.example.workers.dev",
          debugToken: "right-token",
        });
        const res = await app.fetch(
          new Request("https://example.com" + path, {
            headers: { "x-debug-token": "wrong-token" },
          }),
          env,
        );
        expect(res.status).toBe(401);
      });

      it("401s in staging env when no token header is sent", async () => {
        const env = envWith({
          gatewayOrigin: "https://managed-agents-integrations-staging.example.workers.dev",
          debugToken: "right-token",
        });
        const res = await app.fetch(
          new Request("https://example.com" + path),
          env,
        );
        expect(res.status).toBe(401);
      });
    });
  }

  it("is case-insensitive for the 'staging' substring (defense-in-depth)", async () => {
    const env = envWith({
      gatewayOrigin: "https://Some-Staging-Cluster.example.com",
      debugToken: "right-token",
    });
    const res = await app.fetch(
      new Request("https://example.com/admin/linear-reauth-link?installation_id=x", {
        headers: { "x-debug-token": "wrong" },
      }),
      env,
    );
    // Case-insensitive match → staging recognized → 401 (not 404)
    expect(res.status).toBe(401);
  });

  it("does not misclassify host substrings that merely contain 'stag'", async () => {
    const env = envWith({
      gatewayOrigin: "https://stagecoach.openma.dev",
      debugToken: "right-token",
    });
    const res = await app.fetch(
      new Request("https://example.com/admin/linear-reauth-link?installation_id=x", {
        headers: { "x-debug-token": "right-token" },
      }),
      env,
    );
    // \bstaging\b word boundary → "stagecoach" doesn't match → prod → 404
    expect(res.status).toBe(404);
  });
});
