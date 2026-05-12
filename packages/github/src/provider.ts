// GitHubProvider — implements integrations-core's IntegrationProvider for
// GitHub. Mirrors the LinearProvider's A1 (per-publication App) flow:
//
//   1. startInstall → mints `appId` + `formToken`, returns the Setup URL +
//      Webhook URL the user pastes into GitHub's "Register a new GitHub App"
//      form.
//   2. submit_credentials → user pastes back the App's numeric id, slug,
//      private key (PEM), webhook secret, and (optionally) OAuth client
//      id/secret. We discover the bot login via `GET /app` and persist all of
//      it. Returns the install URL — `https://github.com/apps/<slug>/installations/new`.
//   3. installation callback → GitHub redirects to our setup URL with
//      `installation_id` + `setup_action`. We mint a fresh installation token,
//      stash it in a fresh vault credential, and create the publication.
//
// All runtime concerns (HTTP, storage, JWT, sessions) come from the Container.

import type {
  Container,
  ContinueInstallInput,
  IntegrationProvider,
  InstallComplete,
  InstallStep,
  McpScope,
  McpToolDescriptor,
  McpToolResult,
  ProviderId,
  StartInstallInput,
  WebhookOutcome,
  WebhookRequest,
  CapabilityKey,
  Persona,
  Publication,
} from "@open-managed-agents/integrations-core";

import {
  DEFAULT_GITHUB_CAPABILITIES,
  DEFAULT_GITHUB_MCP_URL,
  type GitHubConfig,
} from "./config";
import { GitHubApiClient } from "./api/client";
import {
  buildInstallUrl,
  buildInstallationTokenRequest,
  mintAppJwt,
  parseInstallationTokenResponse,
} from "./oauth/protocol";
import {
  buildManifest,
  buildManifestConversionRequest,
  parseManifestConversionResponse,
} from "./oauth/manifest";
import {
  parseWebhook,
  type NormalizedWebhookEvent,
  type RawWebhookEnvelope,
} from "./webhook/parse";

export interface GitHubContainer extends Container {}

const OAUTH_STATE_TTL_SECONDS = 30 * 60; // 30 min — covers slow OAuth UX
const PROVIDER_ID: ProviderId = "github";

export class GitHubProvider implements IntegrationProvider {
  readonly id: ProviderId = PROVIDER_ID;
  private readonly api: GitHubApiClient;

  constructor(
    private readonly container: GitHubContainer,
    private readonly config: GitHubConfig,
  ) {
    this.api = new GitHubApiClient(container.http);
  }

  // ─── Install ─────────────────────────────────────────────────────────

  async startInstall(input: StartInstallInput): Promise<InstallStep | InstallComplete> {
    return this.startDedicatedFlow(input);
  }

  async continueInstall(
    input: ContinueInstallInput,
  ): Promise<InstallStep | InstallComplete> {
    const payload = input.payload as { kind?: string; [k: string]: unknown };
    if (payload.kind === "submit_credentials") {
      return this.submitDedicatedCredentials(payload);
    }
    if (payload.kind === "handoff_link") {
      return this.createHandoffLink(payload);
    }
    if (payload.kind === "install_callback") {
      return this.completeInstall(
        (payload.appOmaId as string) ?? "",
        (payload.installationId as string) ?? "",
        (payload.state as string) ?? "",
      );
    }
    if (payload.kind === "manifest_callback") {
      return this.completeManifestConversion(
        (payload.code as string) ?? "",
        (payload.state as string) ?? "",
      );
    }
    throw new Error(
      `GitHubProvider.continueInstall: unknown payload kind '${payload.kind}'`,
    );
  }

  // ─── A1 (full identity, BYO GitHub App) ────────────────────────────────

  private async startDedicatedFlow(input: StartInstallInput): Promise<InstallStep> {
    // Mint our internal appId now so step 1 hands the user the *final* setup
    // URL they paste into GitHub's App-creation form. Mirrors Linear A1's
    // approach — saves a placeholder reconciliation later.
    const appOmaId = this.container.ids.generate();
    const formToken = await this.container.jwt.sign(
      {
        kind: "github.a1.form",
        userId: input.userId,
        agentId: input.agentId,
        environmentId: input.environmentId,
        persona: input.persona,
        returnUrl: input.returnUrl,
        appOmaId,
      },
      OAUTH_STATE_TTL_SECONDS,
    );

    return {
      kind: "step",
      step: "credentials_form",
      data: {
        formToken,
        appOmaId,
        suggestedAppName: input.persona.name,
        suggestedAvatarUrl: input.persona.avatarUrl,
        // GitHub App "Setup URL" — where GitHub redirects after install.
        setupUrl: this.dedicatedSetupUri(appOmaId),
        webhookUrl: this.dedicatedWebhookUri(appOmaId),
        // Recommended (default) UX path: open this URL, browser auto-POSTs a
        // manifest to GitHub. Zero copy-paste, ~30s end-to-end.
        manifestStartUrl: `${this.config.gatewayOrigin}/github/manifest/start/${formToken}`,
        // Fields the user must fill in on GitHub's "Register a new GitHub App"
        // form (or via API) IF they go the manual path. The integration only
        // cares about a subset.
        recommendedPermissions: {
          contents: "write",
          issues: "write",
          pull_requests: "write",
          metadata: "read",
          actions: "read",
        },
        recommendedSubscriptions: [
          "issues",
          "issue_comment",
          "pull_request",
          "pull_request_review",
          "pull_request_review_comment",
        ],
      },
    };
  }

  private async submitDedicatedCredentials(
    payload: Record<string, unknown>,
  ): Promise<InstallStep> {
    const formToken = (payload.formToken as string) ?? "";
    const appId = (payload.appId as string) ?? "";
    const privateKey = (payload.privateKey as string) ?? "";
    const webhookSecret = (payload.webhookSecret as string) ?? "";
    // Optional OAuth credentials — only needed if the user later wants
    // user-attributed sign-in. For pure App-bot use both can be omitted.
    const clientId = ((payload.clientId as string) || "").trim() || null;
    const clientSecret = ((payload.clientSecret as string) || "").trim() || null;
    if (!formToken || !appId || !privateKey || !webhookSecret) {
      throw new Error(
        "submit_credentials: formToken, appId, privateKey, webhookSecret required",
      );
    }

    const form = await this.container.jwt.verify<{
      kind: string;
      userId: string;
      agentId: string;
      environmentId: string;
      persona: Persona;
      returnUrl: string;
      appOmaId: string;
    }>(formToken);
    if (form.kind !== "github.a1.form") {
      throw new Error("submit_credentials: invalid formToken kind");
    }
    if (!form.appOmaId) {
      throw new Error(
        "submit_credentials: formToken missing appOmaId — please restart the publish flow",
      );
    }

    // Discover the App slug + bot login from `GET /app` so the install link
    // and the bot identity are both verified — not user-typed strings we'd
    // have to trust. If this fails the credentials are wrong; fail fast
    // before we persist anything.
    const appJwt = await mintAppJwt(privateKey, { appId });
    const appInfo = await this.api.getApp(appJwt);
    if (String(appInfo.id) !== appId) {
      throw new Error(
        `submit_credentials: appId mismatch — pasted ${appId}, GitHub says ${appInfo.id}`,
      );
    }

    // Upsert keyed on appOmaId so a re-submit (page refresh) doesn't create
    // a second row with a different id. tenant_id is required at write time
    // so the row can be mechanically routed to a per-tenant DB later.
    const tenantId = await this.container.tenants.resolveByUserId(form.userId);
    const app = await this.container.githubApps.insert({
      id: form.appOmaId,
      tenantId,
      publicationId: null,
      appId,
      appSlug: appInfo.slug,
      botLogin: appInfo.botLogin,
      clientId,
      clientSecret,
      webhookSecret,
      privateKey,
    });

    // Mint a state JWT to round-trip through GitHub's install callback.
    const state = await this.container.jwt.sign(
      {
        kind: "github.install.dedicated",
        appOmaId: app.id,
        userId: form.userId,
        agentId: form.agentId,
        environmentId: form.environmentId,
        persona: form.persona,
        returnUrl: form.returnUrl,
        nonce: this.container.ids.generate(),
      },
      OAUTH_STATE_TTL_SECONDS,
    );
    const url = buildInstallUrl({ appSlug: appInfo.slug, state });

    return {
      kind: "step",
      step: "install_link",
      data: {
        url,
        appOmaId: app.id,
        appSlug: appInfo.slug,
        botLogin: appInfo.botLogin,
        setupUrl: this.dedicatedSetupUri(app.id),
        webhookUrl: this.dedicatedWebhookUri(app.id),
      },
    };
  }

  private async completeInstall(
    appOmaId: string,
    installationId: string,
    stateToken: string,
  ): Promise<InstallComplete> {
    if (!appOmaId) throw new Error("GitHub install callback: missing appOmaId");
    if (!installationId) throw new Error("GitHub install callback: missing installation_id");
    if (!stateToken) throw new Error("GitHub install callback: missing state");

    const state = await this.container.jwt.verify<{
      kind: string;
      appOmaId: string;
      userId: string;
      agentId: string;
      environmentId: string;
      persona: Persona;
      returnUrl: string;
    }>(stateToken);
    if (state.kind !== "github.install.dedicated") {
      throw new Error("GitHub install callback: invalid state kind");
    }
    if (state.appOmaId !== appOmaId) {
      throw new Error("GitHub install callback: appOmaId mismatch");
    }

    const app = await this.container.githubApps.get(appOmaId);
    if (!app) throw new Error("GitHub install callback: unknown appOmaId");

    const privateKey = await this.container.githubApps.getPrivateKey(app.id);
    if (!privateKey) {
      throw new Error("GitHub install callback: missing private key");
    }

    // Mint a 1-hour installation access token and look up the install's org.
    const appJwt = await mintAppJwt(privateKey, { appId: app.appId });
    const tokReq = buildInstallationTokenRequest(appJwt, installationId);
    const tokRes = await this.container.http.fetch({
      method: "POST",
      url: tokReq.url,
      headers: tokReq.headers,
      body: tokReq.body,
    });
    if (tokRes.status < 200 || tokRes.status >= 300) {
      throw new Error(
        `GitHub installation token: HTTP ${tokRes.status} ${tokRes.body.slice(0, 200)}`,
      );
    }
    const token = parseInstallationTokenResponse(tokRes.body);

    const installDetail = await this.api.getInstallation(appJwt, installationId);

    const tenantId = await this.container.tenants.resolveByUserId(state.userId);
    const installation = await this.container.installations.insert({
      tenantId,
      userId: state.userId,
      providerId: PROVIDER_ID,
      // For GitHub the installation id is the stable workspace handle (orgs
      // can rename, install ids can't). The login goes in workspaceName.
      workspaceId: installationId,
      workspaceName: installDetail.account.login,
      installKind: "dedicated",
      appId: app.id,
      accessToken: token.token,
      refreshToken: null,
      // Persist the granted permissions as scopes for observability. We don't
      // re-validate against this set on each call — GitHub does that itself.
      scopes: Object.keys(installDetail.permissions),
      // Bot login as our `botUserId` field (TEXT-typed, semantically OK).
      botUserId: app.botLogin,
    });

    // One vault, two surfaces:
    //
    //   1. static_bearer credential — outbound proxy injects on calls to the
    //      hosted GitHub MCP server (api.githubcopilot.com/mcp/).
    //   2. cap_cli credential (cli_id="gh") — cap proxy injects Bearer on
    //      sandbox HTTPS to api.github.com / uploads.github.com when the
    //      agent runs `gh` / `git`. Token never enters sandbox process env.
    //
    // Both credentials hold the SAME installation token; rotating one means
    // rotating the other. Sharing one vault keeps them lifecycle-coupled.
    const { vaultId } = await this.container.vaults.createCredentialForUser({
      userId: state.userId,
      vaultName: `GitHub · ${installDetail.account.login} · ${state.persona.name}`,
      displayName: `GitHub MCP token (${state.persona.name})`,
      mcpServerUrl: this.config.mcpServerUrl,
      bearerToken: token.token,
      provider: "github",
    });
    await this.container.vaults.addCapCliCredential({
      userId: state.userId,
      vaultId,
      vaultName: `GitHub · ${installDetail.account.login} · ${state.persona.name}`,
      displayName: `GitHub CLI token (${state.persona.name})`,
      cliId: "gh",
      token: token.token,
      provider: "github",
    });
    await this.container.installations.setVaultId(installation.id, vaultId);

    const publication = await this.container.publications.insert({
      tenantId,
      userId: state.userId,
      agentId: state.agentId,
      installationId: installation.id,
      environmentId: state.environmentId,
      mode: "full",
      status: "live",
      persona: state.persona,
      capabilities: new Set<CapabilityKey>(
        this.config.defaultCapabilities ?? DEFAULT_GITHUB_CAPABILITIES,
      ),
      // GitHub events are usually issue/PR-scoped; per_issue means we keep
      // one running session per (issue or PR) until it's closed.
      sessionGranularity: "per_issue",
    });
    await this.container.githubApps.setPublicationId(app.id, publication.id);

    return { kind: "complete", publicationId: publication.id };
  }

  private dedicatedSetupUri(appOmaId: string): string {
    return `${this.config.gatewayOrigin}/github/install/app/${appOmaId}/callback`;
  }
  private dedicatedWebhookUri(appOmaId: string): string {
    return `${this.config.gatewayOrigin}/github/webhook/app/${appOmaId}`;
  }
  private manifestRedirectUri(): string {
    return `${this.config.gatewayOrigin}/github/manifest/callback`;
  }

  /**
   * Build the manifest payload + state JWT for the manifest-flow start page.
   * Called by the gateway's GET /github/manifest/start/:formToken handler —
   * provider stays free of HTTP/HTML rendering, just supplies the data.
   */
  async prepareManifestForm(
    formToken: string,
  ): Promise<{
    manifest: Record<string, unknown>;
    state: string;
    appOmaId: string;
    suggestedAppName: string;
  }> {
    const form = await this.container.jwt.verify<{
      kind: string;
      userId: string;
      agentId: string;
      environmentId: string;
      persona: Persona;
      returnUrl: string;
      appOmaId: string;
    }>(formToken);
    if (form.kind !== "github.a1.form") {
      throw new Error("prepareManifestForm: invalid formToken kind");
    }
    if (!form.appOmaId) {
      throw new Error("prepareManifestForm: formToken missing appOmaId");
    }

    // Sign a separate state JWT for the manifest callback path so we can
    // reconstruct context after GitHub round-trips us. Includes appOmaId so
    // the webhook URL we baked into the manifest matches the App row we
    // eventually persist.
    const state = await this.container.jwt.sign(
      {
        kind: "github.manifest.state",
        appOmaId: form.appOmaId,
        userId: form.userId,
        agentId: form.agentId,
        environmentId: form.environmentId,
        persona: form.persona,
        returnUrl: form.returnUrl,
        nonce: this.container.ids.generate(),
      },
      OAUTH_STATE_TTL_SECONDS,
    );

    const manifest = buildManifest({
      name: form.persona.name,
      url: this.config.homepageUrl ?? "https://openma.dev",
      webhookUrl: this.dedicatedWebhookUri(form.appOmaId),
      redirectUrl: this.manifestRedirectUri(),
      setupUrl: this.dedicatedSetupUri(form.appOmaId),
      permissions: {
        contents: "write",
        issues: "write",
        pull_requests: "write",
        metadata: "read",
        actions: "read",
      },
      events: [
        "issues",
        "issue_comment",
        "pull_request",
        "pull_request_review",
        "pull_request_review_comment",
      ],
      public: false,
    });

    return {
      manifest,
      state,
      appOmaId: form.appOmaId,
      suggestedAppName: form.persona.name,
    };
  }

  /**
   * Manifest callback: GitHub redirects here with `?code=&state=`. We exchange
   * the code for App credentials (id, slug, pem, webhook_secret), persist
   * them, and return an InstallStep with the install URL — same shape as the
   * manual `submit_credentials` path's output, so the wizard can keep going
   * regardless of which path was taken.
   */
  private async completeManifestConversion(
    code: string,
    stateToken: string,
  ): Promise<InstallStep> {
    if (!code) throw new Error("manifest callback: missing code");
    if (!stateToken) throw new Error("manifest callback: missing state");

    const state = await this.container.jwt.verify<{
      kind: string;
      appOmaId: string;
      userId: string;
      agentId: string;
      environmentId: string;
      persona: Persona;
      returnUrl: string;
    }>(stateToken);
    if (state.kind !== "github.manifest.state") {
      throw new Error("manifest callback: invalid state kind");
    }

    // Exchange code for App credentials. GitHub invalidates `code` after
    // first use, so retries on failure must restart the manifest flow.
    const req = buildManifestConversionRequest(code);
    const res = await this.container.http.fetch({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: req.body,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `manifest conversion: HTTP ${res.status} ${res.body.slice(0, 200)}`,
      );
    }
    const result = parseManifestConversionResponse(res.body);

    // Persist as a github_apps row keyed on the OMA-internal appOmaId we
    // pre-allocated at form-token time. Same upsert path as manual submit.
    const tenantId = await this.container.tenants.resolveByUserId(state.userId);
    const app = await this.container.githubApps.insert({
      id: state.appOmaId,
      tenantId,
      publicationId: null,
      appId: String(result.id),
      appSlug: result.slug,
      botLogin: result.botLogin,
      clientId: result.clientId || null,
      clientSecret: result.clientSecret || null,
      webhookSecret: result.webhookSecret,
      privateKey: result.pem,
    });

    // Now mint the install-state JWT so the user can click through to install.
    const installState = await this.container.jwt.sign(
      {
        kind: "github.install.dedicated",
        appOmaId: app.id,
        userId: state.userId,
        agentId: state.agentId,
        environmentId: state.environmentId,
        persona: state.persona,
        returnUrl: state.returnUrl,
        nonce: this.container.ids.generate(),
      },
      OAUTH_STATE_TTL_SECONDS,
    );
    const url = buildInstallUrl({ appSlug: app.appSlug, state: installState });

    return {
      kind: "step",
      step: "install_link",
      data: {
        url,
        appOmaId: app.id,
        appSlug: app.appSlug,
        botLogin: app.botLogin,
        setupUrl: this.dedicatedSetupUri(app.id),
        webhookUrl: this.dedicatedWebhookUri(app.id),
        // Round-trip returnUrl so the gateway can redirect the user's browser
        // back to the Console wizard with a "ready to install" signal.
        returnUrl: state.returnUrl,
      },
    };
  }

  /**
   * Re-signs a 30-minute formToken into a 7-day handoff token an admin can
   * use without OMA login.
   */
  private async createHandoffLink(
    payload: Record<string, unknown>,
  ): Promise<InstallStep> {
    const formToken = (payload.formToken as string) ?? "";
    if (!formToken) throw new Error("handoff_link: formToken required");
    const form = await this.container.jwt.verify<{
      kind: string;
      userId: string;
      agentId: string;
      environmentId: string;
      persona: Persona;
      returnUrl: string;
      appOmaId: string;
    }>(formToken);
    if (form.kind !== "github.a1.form") {
      throw new Error("handoff_link: invalid formToken kind");
    }
    const handoffToken = await this.container.jwt.sign(
      { ...form, kind: "github.a1.form", handoff: true },
      7 * 24 * 60 * 60,
    );
    return {
      kind: "step",
      step: "install_link",
      data: {
        url: `${this.config.gatewayOrigin}/github-setup/${handoffToken}`,
        expiresInDays: 7,
      },
    };
  }

  // ─── Webhook ─────────────────────────────────────────────────────────

  async handleWebhook(req: WebhookRequest): Promise<WebhookOutcome> {
    if (!req.deliveryId) {
      return { handled: false, reason: "missing_delivery_id" };
    }

    // Path-derived: which OMA-internal app id is this delivery for? The route
    // handler stuffs it into `installationId` since the WebhookRequest shape
    // doesn't have a per-app field — it gets reinterpreted here.
    const appOmaId = req.installationId;
    if (!appOmaId) {
      return { handled: false, reason: "missing_app_id_in_path" };
    }

    const app = await this.container.githubApps.get(appOmaId);
    if (!app) {
      return { handled: false, reason: "unknown_app" };
    }
    if (!app.publicationId) {
      // App row exists but install hasn't completed yet — webhook arrived too
      // early. GitHub will retry; by then the install row should be there.
      return { handled: false, reason: "app_pending_install" };
    }

    // Verify HMAC. GitHub sends `sha256=<hex>` in `x-hub-signature-256`.
    const sigHeader =
      req.headers["x-hub-signature-256"] ?? req.headers["X-Hub-Signature-256"] ?? "";
    if (!sigHeader.startsWith("sha256=")) {
      return { handled: false, reason: "missing_or_malformed_signature" };
    }
    const sigHex = sigHeader.slice("sha256=".length);
    const webhookSecret = await this.container.githubApps.getWebhookSecret(app.id);
    if (!webhookSecret) {
      return { handled: false, reason: "missing_webhook_secret" };
    }
    const ok = await this.container.hmac.verify(webhookSecret, req.rawBody, sigHex);
    if (!ok) return { handled: false, reason: "invalid_signature" };

    // Idempotency: refuse to dispatch the same delivery twice.
    const fresh = await this.container.webhookEvents.recordIfNew(
      req.deliveryId,
      app.tenantId, // Phase 0: nullable until backfill of pre-existing rows
      app.publicationId, // stash publicationId here for traceability
      req.headers["x-github-event"] ?? "unknown",
      this.container.clock.nowMs(),
    );
    if (!fresh) return { handled: false, reason: "duplicate_delivery" };

    let raw: RawWebhookEnvelope;
    try {
      raw = JSON.parse(req.rawBody) as RawWebhookEnvelope;
    } catch {
      await this.container.webhookEvents.attachError(req.deliveryId, "invalid_json");
      return { handled: false, reason: "invalid_json" };
    }
    const event = parseWebhook({
      eventType: req.headers["x-github-event"] ?? "",
      deliveryId: req.deliveryId,
      raw,
      botLogin: app.botLogin,
    });
    if (!event) {
      await this.container.webhookEvents.attachError(req.deliveryId, "unparseable");
      return { handled: false, reason: "unparseable" };
    }

    const publication = await this.container.publications.get(app.publicationId);
    if (!publication || publication.status !== "live") {
      await this.container.webhookEvents.attachError(req.deliveryId, "no_live_publication");
      return { handled: false, reason: "no_live_publication" };
    }
    await this.container.webhookEvents.attachPublication(
      req.deliveryId,
      publication.id,
    );

    if (event.kind === null) {
      // Recorded for observability; nothing to dispatch.
      return { handled: false, reason: "ignored_event_kind" };
    }

    const sessionId = await this.dispatchEvent(publication, event);
    await this.container.webhookEvents.attachSession(req.deliveryId, sessionId);

    return {
      handled: true,
      reason: "dedicated_install",
      publicationId: publication.id,
      sessionId,
      tenantId: app.tenantId,
    };
  }

  private async dispatchEvent(
    publication: Publication,
    event: NormalizedWebhookEvent,
  ): Promise<string> {
    const installation = await this.container.installations.get(publication.installationId);
    const vaultIds = installation?.vaultId ? [installation.vaultId] : [];
    const mcpServers = [{ name: "github", url: this.config.mcpServerUrl }];

    // Refresh the installation token before handing the session a vault.
    // GitHub installation tokens last ~1 hour; without rotation the bot
    // would silently start 401-ing on long-running sessions or any session
    // started >1h after install. Idempotent on success — if the install was
    // revoked, this will throw and the webhook handler returns reason=
    // "token_refresh_failed" upstream.
    if (installation?.vaultId && installation.appId) {
      try {
        await this.refreshInstallationToken(installation);
      } catch (err) {
        // Don't kill the dispatch on refresh failure — the existing token
        // may still be valid (we refresh proactively, not reactively). Just
        // log; the agent's first MCP call will surface a clearer error if
        // the token is actually dead.
        console.warn(
          `[github] token refresh failed for installation ${installation.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const sessionEvent = {
      type: "user.message" as const,
      content: [
        { type: "text" as const, text: this.renderEventAsUserMessage(event) },
      ],
      metadata: {
        github: {
          installationId: event.installationId,
          repository: event.repository,
          itemKind: event.itemKind,
          itemNumber: event.itemNumber,
          commentId: event.commentId,
          actorLogin: event.actorLogin,
          eventKind: event.kind,
          eventType: event.eventType,
          deliveryId: event.deliveryId,
          htmlUrl: event.htmlUrl,
        },
      },
    };

    // per_issue session granularity: keep one running session per (repo,
    // issue/PR number). We use a synthetic issue id "<repo>#<number>" — issues
    // and PRs share the number namespace within a repo.
    const issueKey =
      event.repository && event.itemNumber != null
        ? `${event.repository}#${event.itemNumber}`
        : null;

    if (publication.sessionGranularity === "per_issue" && issueKey) {
      const existing = await this.container.issueSessions.getByIssue(
        publication.id,
        issueKey,
      );
      if (existing && existing.status === "active") {
        await this.container.sessions.resume(
          publication.userId,
          existing.sessionId,
          sessionEvent,
        );
        return existing.sessionId;
      }
      const created = await this.container.sessions.create({
        userId: publication.userId,
        agentId: publication.agentId,
        environmentId: publication.environmentId,
        vaultIds,
        mcpServers,
        metadata: {
          github: { issueKey, repository: event.repository },
        },
        initialEvent: sessionEvent,
      });
      await this.container.issueSessions.insert({
        tenantId: publication.tenantId, // inherits from the publication
        publicationId: publication.id,
        issueId: issueKey,
        sessionId: created.sessionId,
        status: "active",
        createdAt: this.container.clock.nowMs(),
      });
      return created.sessionId;
    }

    // per_event (or per_issue without an issue key — e.g. workflow_run): always fresh.
    const created = await this.container.sessions.create({
      userId: publication.userId,
      agentId: publication.agentId,
      environmentId: publication.environmentId,
      vaultIds,
      mcpServers,
      metadata: { github: { repository: event.repository } },
      initialEvent: sessionEvent,
    });
    return created.sessionId;
  }

  private renderEventAsUserMessage(event: NormalizedWebhookEvent): string {
    // Compact text the agent gets as the first user message. Real context
    // (full bodies, file diffs, comments) comes via the agent's MCP tools.
    const lines: string[] = [];
    const where = event.repository
      ? `${event.repository}#${event.itemNumber ?? "?"}`
      : event.repository ?? "?";
    lines.push(`GitHub ${event.kind ?? event.eventType} on ${where}`);
    if (event.itemTitle) lines.push(`Title: ${event.itemTitle}`);
    if (event.actorLogin) lines.push(`From: @${event.actorLogin}`);
    if (event.htmlUrl) lines.push(`URL: ${event.htmlUrl}`);
    if (event.commentBody) lines.push(`\nComment:\n${event.commentBody}`);
    return lines.join("\n");
  }

  /**
   * Mint a fresh installation_token via GitHub's `/app/installations/<id>/access_tokens`
   * endpoint and rotate both vault credentials (static_bearer for MCP path,
   * cap_cli (cli_id="gh") for sandbox `gh`/`git`). Throws on any HTTP
   * failure; caller decides whether to swallow.
   */
  private async refreshInstallationToken(installation: {
    id: string;
    userId: string;
    workspaceId: string;
    appId: string | null;
    vaultId: string | null;
  }): Promise<void> {
    if (!installation.appId || !installation.vaultId) return;
    const app = await this.container.githubApps.get(installation.appId);
    if (!app) return;
    const privateKey = await this.container.githubApps.getPrivateKey(app.id);
    if (!privateKey) return;

    const appJwt = await mintAppJwt(privateKey, { appId: app.appId });
    const tokReq = buildInstallationTokenRequest(appJwt, installation.workspaceId);
    const tokRes = await this.container.http.fetch({
      method: "POST",
      url: tokReq.url,
      headers: tokReq.headers,
      body: tokReq.body,
    });
    if (tokRes.status < 200 || tokRes.status >= 300) {
      throw new Error(
        `installation token refresh: HTTP ${tokRes.status} ${tokRes.body.slice(0, 200)}`,
      );
    }
    const fresh = parseInstallationTokenResponse(tokRes.body);

    // Rotate both credentials in the vault to the same fresh token. If the
    // vault is missing one of them (older binding pre-dual-cred), the rotate
    // returns false silently — that's OK.
    await this.container.vaults.rotateBearerToken({
      userId: installation.userId,
      vaultId: installation.vaultId,
      newBearerToken: fresh.token,
    });
    await this.container.vaults.rotateCapCliToken({
      userId: installation.userId,
      vaultId: installation.vaultId,
      cliId: "gh",
      newToken: fresh.token,
    });
  }

  // ─── MCP (deferred — agents talk to GitHub MCP server directly) ──────

  async mcpTools(_scope: McpScope): Promise<readonly McpToolDescriptor[]> {
    // The agent talks to the GitHub MCP server directly via the vault
    // credential; we don't proxy here. Returning [] keeps the integration
    // contract honest — the platform will not advertise extra MCP tools on
    // the OMA side beyond what the upstream MCP server already provides.
    return [];
  }

  async invokeMcpTool(
    _scope: McpScope,
    toolName: string,
    _input: unknown,
  ): Promise<McpToolResult> {
    return {
      ok: false,
      error: {
        code: "not_implemented",
        message:
          `GitHub MCP tools are served by the upstream MCP at ${this.config.mcpServerUrl}; ` +
          `OMA does not proxy "${toolName}".`,
      },
    };
  }
}
