// CF wiring for the integrations routes package.
//
// Builds the per-provider repo bags from buildCfRepos / Slack-specific repos
// and forwards install-proxy calls to the INTEGRATIONS service binding.
// Logic — CRUD shapes, dispatch-rule validation, /v1/oma/* mirroring — is in
// packages/http-routes/src/integrations.

import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import {
  buildCfRepos,
  CryptoIdGenerator,
  D1GitHubAppRepo,
  D1GitHubInstallationRepo,
  D1GitHubPublicationRepo,
  D1SlackAppRepo,
  D1SlackInstallationRepo,
  D1SlackPublicationRepo,
  WebCryptoAesGcm,
} from "@open-managed-agents/integrations-adapters-cf";
import {
  buildIntegrationsRoutes,
  type IntegrationsBags,
  type InstallProxyForwarder,
} from "@open-managed-agents/http-routes";

interface Vars {
  Variables: { tenant_id: string; user_id?: string };
}

function bagsFor(c: import("hono").Context<{ Bindings: Env } & Vars>): IntegrationsBags {
  const env = c.env;
  const k = (env as unknown as Record<string, unknown>).PLATFORM_ROOT_SECRET;
  if (typeof k !== "string" || !k || !env.INTEGRATIONS_DB) {
    return { linear: null, github: null, slack: null };
  }
  const linearRepos = buildCfRepos({
    integrationsDb: env.INTEGRATIONS_DB,
    controlPlaneDb: env.AUTH_DB,
    PLATFORM_ROOT_SECRET: k,
  });
  // Slack/GitHub need their parallel installations/publications/apps repos —
  // buildCfRepos exposes the github_* ones, but slack lives in slack_*
  // tables and uses Slack-specific D1 repos.
  const crypto = new WebCryptoAesGcm(k, "integrations.tokens");
  const ids = new CryptoIdGenerator();
  return {
    linear: {
      installations: linearRepos.linearInstallations,
      publications: linearRepos.linearPublications,
      apps: linearRepos.apps,
      dispatchRules: linearRepos.dispatchRules,
    },
    github: {
      installations: new D1GitHubInstallationRepo(env.INTEGRATIONS_DB, crypto, ids),
      publications: new D1GitHubPublicationRepo(env.INTEGRATIONS_DB, ids),
      githubApps: new D1GitHubAppRepo(env.INTEGRATIONS_DB, crypto, ids),
    },
    slack: {
      installations: new D1SlackInstallationRepo(env.INTEGRATIONS_DB, crypto, ids),
      publications: new D1SlackPublicationRepo(env.INTEGRATIONS_DB, ids),
      apps: new D1SlackAppRepo(env.INTEGRATIONS_DB, crypto, ids),
    },
  };
}

function installProxyFor(c: import("hono").Context<{ Bindings: Env } & Vars>): InstallProxyForwarder | null {
  const env = c.env;
  if (!env.INTEGRATIONS) return null;
  const internalSecret = env.INTEGRATIONS_INTERNAL_SECRET;
  return {
    async forward({ subpath, body, needsInternalSecret }) {
      if (needsInternalSecret && !internalSecret) {
        return new Response(
          JSON.stringify({ error: "INTEGRATIONS_INTERNAL_SECRET not configured" }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (needsInternalSecret && internalSecret) headers["x-internal-secret"] = internalSecret;
      const res = await env.INTEGRATIONS!.fetch(`http://gateway/${subpath}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      return new Response(res.body, { status: res.status, headers: res.headers });
    },
  };
}

const wrapper = new Hono<{ Bindings: Env } & Vars>();

// Mount the package routes onto our wrapper's Hono so the outer auth
// middleware's `tenant_id` / `user_id` Variables flow through to the
// per-route user-scoped guard inside `buildIntegrationsRoutes`.
//
// Earlier this used `inner.fetch(c.req.raw, c.env, c.executionCtx)`,
// which creates a brand-new context inside the inner Hono app — the
// outer Variables were dropped, so the guard read `user_id` as
// undefined and returned 403 even for cookie-authenticated Console
// users.
const inner = buildIntegrationsRoutes({
  bags: (ctx) => bagsFor(ctx as import("hono").Context<{ Bindings: Env } & Vars>),
  installProxy: (ctx) =>
    installProxyFor(ctx as import("hono").Context<{ Bindings: Env } & Vars>),
});
wrapper.route("/", inner);

export default wrapper;
