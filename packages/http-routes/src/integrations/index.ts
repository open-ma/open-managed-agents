// Integrations CRUD + lookup + install-proxy routes.
//
// Mounted at /v1/integrations/* AND /v1/oma/integrations/* on both runtimes.
// CF wires the D1 repo bag via integrations-adapters-cf; Node wires the
// SqlClient repo bag via integrations-adapters-node. The route bodies don't
// know which.
//
// The install-proxy endpoints (POST /:provider/{start-a1,credentials,
// handoff-link,personal-token}) used to reverse-proxy to the INTEGRATIONS
// service binding on CF. With the OAuth/install routes folded into this
// package and mounted on the same app, the proxy can either still forward
// (CF, where INTEGRATIONS is a service binding) or call the in-process
// install handlers directly (Node). The host wires `forwardInstall` to
// pick the right path.

import { Hono } from "hono";
import type {
  CapabilityKey,
  Persona,
  Publication,
  SessionGranularity,
  AppRepo,
  GitHubAppRepo,
  InstallationRepo,
  PublicationRepo,
  DispatchRuleRepo,
} from "@open-managed-agents/integrations-core";

interface Vars {
  Variables: { tenant_id: string; user_id?: string };
}

/**
 * Per-request repo bag, one per provider. Integrations CRUD reads only —
 * writes happen via the install/OAuth handlers in the integrations gateway.
 */
export interface IntegrationsRepoBag {
  installations: InstallationRepo;
  publications: PublicationRepo;
  apps?: AppRepo | null;
  githubApps?: GitHubAppRepo | null;
  dispatchRules?: DispatchRuleRepo | null;
}

/**
 * What the host hands the routes per-request. Returning `null` for a
 * provider's bag means "this deployment doesn't expose that provider"; the
 * routes return 503 with a remediation message.
 */
export interface IntegrationsBags {
  linear: IntegrationsRepoBag | null;
  github: IntegrationsRepoBag | null;
  slack: IntegrationsRepoBag | null;
}

/**
 * Forward an install-proxy call to the host-specific implementation. CF
 * forwards via the INTEGRATIONS service binding; Node calls the in-process
 * install handler. Body has been parsed already for clarity, headers
 * include the auth context (e.g. `x-internal-secret` injection).
 *
 * Returns a Response so the route can stream it through unchanged.
 */
export interface InstallProxyForwarder {
  /**
   * @param subpath e.g. "linear/publications/start-a1"
   * @param body parsed JSON body (will be re-stringified for forward).
   * @param needsInternalSecret true if the proxy must inject x-internal-secret.
   */
  forward(opts: {
    subpath: string;
    body: unknown;
    needsInternalSecret: boolean;
  }): Promise<Response>;
}

export interface IntegrationsRoutesDeps {
  /** Per-request repo bag resolver. CF reads c.env on demand; Node returns
   *  the same singleton bags every call. */
  bags: (c: import("hono").Context) => IntegrationsBags;
  /** Install-proxy forwarder. Either a static instance (Node — bridge is a
   *  long-lived singleton) or a per-request resolver (CF — needs c.env +
   *  c.executionCtx for the service-binding fetch). Null disables the
   *  install-proxy endpoints (they return 503).
   */
  installProxy:
    | InstallProxyForwarder
    | ((c: import("hono").Context) => InstallProxyForwarder | null)
    | null;
}

export function buildIntegrationsRoutes(deps: IntegrationsRoutesDeps) {
  const app = new Hono<Vars>();

  // Per-route guard: every endpoint here is user-scoped because publications
  // belong to a specific user, not just a tenant. Reject early with a clear
  // remediation if user_id is missing.
  app.use("*", async (c, next) => {
    if (c.get("user_id")) return next();
    return c.json(
      {
        error:
          "user-scoped endpoint: regenerate your API key (legacy keys lack user_id) or sign in with a session cookie",
      },
      403,
    );
  });

  function bagOr503(c: import("hono").Context, provider: "linear" | "github" | "slack") {
    const bags = deps.bags(c);
    const bag = bags[provider];
    if (!bag) {
      return {
        bag: null,
        err: c.json(
          { error: `${provider} integration not configured on this deployment` },
          503,
        ) as Response,
      };
    }
    return { bag, err: null };
  }

  function buildProviderRoutes(provider: "linear" | "github" | "slack") {
    const sub = new Hono<Vars>();

    sub.get("/installations", async (c) => {
      const userId = c.get("user_id")!;
      const { bag, err } = bagOr503(c, provider);
      if (err) return err;
      const installations = await bag.installations.listByUser(userId, provider);
      return c.json({
        data: installations.map((i) => ({
          id: i.id,
          workspace_id: i.workspaceId,
          workspace_name: i.workspaceName,
          install_kind: i.installKind,
          // Linear/Slack expose bot_user_id; GitHub exposes bot_login. We
          // emit both keys so callers don't need to special-case.
          bot_user_id: i.botUserId,
          bot_login: i.botUserId,
          vault_id: i.vaultId,
          created_at: i.createdAt,
        })),
      });
    });

    sub.get("/installations/:id/publications", async (c) => {
      const userId = c.get("user_id")!;
      const installationId = c.req.param("id");
      const { bag, err } = bagOr503(c, provider);
      if (err) return err;
      const installation = await bag.installations.get(installationId);
      if (!installation || installation.userId !== userId) {
        return c.json({ error: "not found" }, 404);
      }
      const publications = await bag.publications.listByInstallation(installationId);
      return c.json({ data: publications.map(serializePublication) });
    });

    sub.get("/agents/:id/publications", async (c) => {
      const userId = c.get("user_id")!;
      const agentId = c.req.param("id");
      const { bag, err } = bagOr503(c, provider);
      if (err) return err;
      const publications = await bag.publications.listByUserAndAgent(userId, agentId);
      return c.json({ data: publications.map(serializePublication) });
    });

    sub.get("/publications/:id", async (c) => {
      const userId = c.get("user_id")!;
      const id = c.req.param("id");
      const { bag, err } = bagOr503(c, provider);
      if (err) return err;
      const pub = await bag.publications.get(id);
      if (!pub || pub.userId !== userId) return c.json({ error: "not found" }, 404);
      return c.json(serializePublication(pub));
    });

    sub.patch("/publications/:id", async (c) => {
      const userId = c.get("user_id")!;
      const id = c.req.param("id");
      const body = (await c.req.json()) as PatchBody;
      const { bag, err } = bagOr503(c, provider);
      if (err) return err;
      const pub = await bag.publications.get(id);
      if (!pub || pub.userId !== userId) return c.json({ error: "not found" }, 404);

      if (body.persona) {
        const merged: Persona = {
          name: body.persona.name ?? pub.persona.name,
          avatarUrl:
            body.persona.avatarUrl !== undefined
              ? body.persona.avatarUrl
              : pub.persona.avatarUrl,
        };
        await bag.publications.updatePersona(id, merged);
      }
      if (body.capabilities) {
        await bag.publications.updateCapabilities(id, new Set(body.capabilities));
      }
      const updated = await bag.publications.get(id);
      return c.json(updated ? serializePublication(updated) : { id });
    });

    sub.delete("/publications/:id", async (c) => {
      const userId = c.get("user_id")!;
      const id = c.req.param("id");
      const { bag, err } = bagOr503(c, provider);
      if (err) return err;
      const pub = await bag.publications.get(id);
      if (!pub || pub.userId !== userId) return c.json({ error: "not found" }, 404);
      await bag.publications.markUnpublished(id, Date.now());
      return c.json({ id, status: "unpublished" });
    });

    // ─── Install proxy endpoints ─────────────────────────────────────
    sub.post("/start-a1", async (c) => {
      const proxy = typeof deps.installProxy === "function" ? deps.installProxy(c) : deps.installProxy; if (!proxy) {
        return c.json({ error: "install proxy not configured" }, 503);
      }
      const userId = c.get("user_id")!;
      const body = (await c.req.json()) as Record<string, unknown>;
      return proxy.forward({
        subpath: `${provider}/publications/start-a1`,
        body: { ...body, userId },
        needsInternalSecret: true,
      });
    });

    sub.post("/credentials", async (c) => {
      const proxy = typeof deps.installProxy === "function" ? deps.installProxy(c) : deps.installProxy; if (!proxy) {
        return c.json({ error: "install proxy not configured" }, 503);
      }
      const body = (await c.req.json()) as Record<string, unknown>;
      // /credentials uses formToken JWT auth — no internal secret needed.
      return proxy.forward({
        subpath: `${provider}/publications/credentials`,
        body,
        needsInternalSecret: false,
      });
    });

    sub.post("/handoff-link", async (c) => {
      const proxy = typeof deps.installProxy === "function" ? deps.installProxy(c) : deps.installProxy; if (!proxy) {
        return c.json({ error: "install proxy not configured" }, 503);
      }
      const body = (await c.req.json()) as Record<string, unknown>;
      return proxy.forward({
        subpath: `${provider}/publications/handoff-link`,
        body,
        needsInternalSecret: true,
      });
    });

    if (provider === "linear") {
      sub.post("/personal-token", async (c) => {
        const proxy = typeof deps.installProxy === "function" ? deps.installProxy(c) : deps.installProxy; if (!proxy) {
          return c.json({ error: "install proxy not configured" }, 503);
        }
        const userId = c.get("user_id")!;
        const body = (await c.req.json()) as Record<string, unknown>;
        return proxy.forward({
          subpath: "linear/publications/personal-token",
          body: { ...body, userId },
          needsInternalSecret: true,
        });
      });

      // ─── Dispatch rules CRUD ───────────────────────────────────────
      sub.get("/publications/:id/dispatch-rules", async (c) => {
        const userId = c.get("user_id")!;
        const id = c.req.param("id");
        const { bag, err } = bagOr503(c, "linear");
        if (err) return err;
        if (!bag.dispatchRules) {
          return c.json({ error: "dispatch rules not configured" }, 503);
        }
        const pub = await bag.publications.get(id);
        if (!pub || pub.userId !== userId) return c.json({ error: "not found" }, 404);
        const rules = await bag.dispatchRules.listByPublication(id);
        return c.json({ rules: rules.map(serializeDispatchRule) });
      });

      sub.post("/publications/:id/dispatch-rules", async (c) => {
        const userId = c.get("user_id")!;
        const id = c.req.param("id");
        const body = (await c.req.json()) as DispatchRulePostBody;
        const { bag, err } = bagOr503(c, "linear");
        if (err) return err;
        if (!bag.dispatchRules) {
          return c.json({ error: "dispatch rules not configured" }, 503);
        }
        const pub = await bag.publications.get(id);
        if (!pub || pub.userId !== userId) return c.json({ error: "not found" }, 404);

        // Reject "match everything" rules — at least one filter required.
        const hasFilter =
          (body.filter_label && body.filter_label.trim().length > 0) ||
          (body.filter_states && body.filter_states.length > 0) ||
          (body.filter_project_id && body.filter_project_id.trim().length > 0);
        if (!hasFilter) {
          return c.json(
            {
              error:
                "at least one of filter_label, filter_states, filter_project_id required",
              hint:
                "An unfiltered rule would assign every active issue in the workspace to the bot. " +
                "Start with filter_label (e.g. 'bot-ready') to scope to opted-in issues.",
            },
            400,
          );
        }

        const maxConcurrent = body.max_concurrent ?? 5;
        if (maxConcurrent < 1 || maxConcurrent > 100) {
          return c.json({ error: "max_concurrent must be 1..100" }, 400);
        }
        const pollIntervalSeconds = body.poll_interval_seconds ?? 600;
        if (pollIntervalSeconds < 60 || pollIntervalSeconds > 86400) {
          return c.json({ error: "poll_interval_seconds must be 60..86400" }, 400);
        }

        const rule = await bag.dispatchRules.insert({
          tenantId: pub.tenantId,
          publicationId: pub.id,
          name: body.name?.trim() || "Auto-pickup",
          enabled: body.enabled ?? true,
          filterLabel: body.filter_label?.trim() || null,
          filterStates: body.filter_states ?? null,
          filterProjectId: body.filter_project_id?.trim() || null,
          maxConcurrent,
          pollIntervalSeconds,
        });
        return c.json(serializeDispatchRule(rule), 201);
      });

      sub.patch("/publications/:id/dispatch-rules/:ruleId", async (c) => {
        const userId = c.get("user_id")!;
        const pubId = c.req.param("id");
        const ruleId = c.req.param("ruleId");
        const body = (await c.req.json()) as DispatchRulePostBody;
        const { bag, err } = bagOr503(c, "linear");
        if (err) return err;
        if (!bag.dispatchRules) {
          return c.json({ error: "dispatch rules not configured" }, 503);
        }
        const pub = await bag.publications.get(pubId);
        if (!pub || pub.userId !== userId) return c.json({ error: "not found" }, 404);
        const existing = await bag.dispatchRules.get(ruleId);
        if (!existing || existing.publicationId !== pubId) {
          return c.json({ error: "not found" }, 404);
        }
        const updated = await bag.dispatchRules.update(ruleId, {
          name: body.name?.trim(),
          enabled: body.enabled,
          filterLabel:
            body.filter_label === undefined ? undefined : body.filter_label?.trim() || null,
          filterStates: body.filter_states,
          filterProjectId:
            body.filter_project_id === undefined
              ? undefined
              : body.filter_project_id?.trim() || null,
          maxConcurrent: body.max_concurrent,
          pollIntervalSeconds: body.poll_interval_seconds,
        });
        if (!updated) return c.json({ error: "not found" }, 404);
        return c.json(serializeDispatchRule(updated));
      });

      sub.delete("/publications/:id/dispatch-rules/:ruleId", async (c) => {
        const userId = c.get("user_id")!;
        const pubId = c.req.param("id");
        const ruleId = c.req.param("ruleId");
        const { bag, err } = bagOr503(c, "linear");
        if (err) return err;
        if (!bag.dispatchRules) {
          return c.json({ error: "dispatch rules not configured" }, 503);
        }
        const pub = await bag.publications.get(pubId);
        if (!pub || pub.userId !== userId) return c.json({ error: "not found" }, 404);
        const existing = await bag.dispatchRules.get(ruleId);
        if (!existing || existing.publicationId !== pubId) {
          return c.json({ error: "not found" }, 404);
        }
        await bag.dispatchRules.delete(ruleId);
        return c.json({ id: ruleId, status: "deleted" });
      });
    }

    return sub;
  }

  app.route("/linear", buildProviderRoutes("linear"));
  app.route("/github", buildProviderRoutes("github"));
  app.route("/slack", buildProviderRoutes("slack"));

  return app;
}

interface PatchBody {
  persona?: Partial<Persona>;
  capabilities?: CapabilityKey[];
  session_granularity?: SessionGranularity;
}

interface DispatchRulePostBody {
  name?: string;
  enabled?: boolean;
  filter_label?: string | null;
  filter_states?: string[] | null;
  filter_project_id?: string | null;
  max_concurrent?: number;
  poll_interval_seconds?: number;
}

function serializePublication(p: Publication) {
  return {
    id: p.id,
    user_id: p.userId,
    agent_id: p.agentId,
    installation_id: p.installationId,
    environment_id: p.environmentId,
    mode: p.mode,
    status: p.status,
    persona: p.persona,
    capabilities: [...p.capabilities],
    session_granularity: p.sessionGranularity,
    created_at: p.createdAt,
    unpublished_at: p.unpublishedAt,
  };
}

function serializeDispatchRule(r: {
  id: string;
  publicationId: string;
  name: string;
  enabled: boolean;
  filterLabel: string | null;
  filterStates: readonly string[] | null;
  filterProjectId: string | null;
  maxConcurrent: number;
  pollIntervalSeconds: number;
  lastPolledAt: number | null;
  createdAt: number;
  updatedAt: number;
}) {
  return {
    id: r.id,
    publication_id: r.publicationId,
    name: r.name,
    enabled: r.enabled,
    filter_label: r.filterLabel,
    filter_states: r.filterStates,
    filter_project_id: r.filterProjectId,
    max_concurrent: r.maxConcurrent,
    poll_interval_seconds: r.pollIntervalSeconds,
    last_polled_at: r.lastPolledAt,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}
