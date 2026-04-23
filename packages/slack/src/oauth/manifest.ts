// Slack App Manifest helpers — pure logic.
//
// Reference: https://docs.slack.dev/reference/manifests
//            https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests
//
// The "Create from manifest" URL flow lets us prefill all manifest fields
// (App name, scopes, events, redirect URLs) and have the user confirm in one
// click on Slack's side. After they click Create, they still need to copy
// Client ID / Client Secret / Signing Secret back into the OMA wizard — Slack
// does NOT ship credentials via callback for the URL flow. The actual
// zero-copy path (apps.manifest.create REST API) requires a Configuration
// Token from the user, which is more friction than the URL flow saves; we
// don't use that path.
//
// Compared to manual app creation at api.slack.com, the URL flow saves the
// user from configuring 10+ scopes, the events-request URL, the redirect
// URL, and 7 event subscriptions one at a time. Net: ~3 minutes saved.

const SLACK_NEW_APP_URL = "https://api.slack.com/apps";

export interface SlackManifestInput {
  /** Persona-derived App display name. */
  personaName: string;
  /** Optional one-line app description, surfaced in Slack's app directory. */
  description?: string;
  /** Where Slack POSTs Events. We bake the OMA-internal app id into the path. */
  webhookUrl: string;
  /** Where Slack redirects after OAuth grant. Per-app; same OMA-internal id. */
  redirectUrl: string;
  /** Bot scopes — go in oauth_config.scopes.bot. */
  botScopes: ReadonlyArray<string>;
  /** User scopes — go in oauth_config.scopes.user. Required for mcp.slack.com. */
  userScopes: ReadonlyArray<string>;
  /** Bot events to subscribe to (e.g. app_mention, message.channels). */
  subscribedEvents: ReadonlyArray<string>;
}

/**
 * Build the JSON manifest. Pure function — no I/O.
 *
 * Schema follows https://docs.slack.dev/reference/manifests but stays
 * minimal: we set what we need and let Slack apply sensible defaults for
 * everything else.
 */
export function buildManifest(input: SlackManifestInput): Record<string, unknown> {
  return {
    display_information: {
      name: input.personaName,
      description: input.description ?? `${input.personaName} — an OpenMA agent`,
    },
    features: {
      bot_user: {
        display_name: input.personaName,
        always_online: true,
      },
      // Show the bot in Slack's "AI assistant" pane (fires assistant_thread_started).
      assistant_view: {
        assistant_description: `Chat with ${input.personaName} in a side pane.`,
      },
    },
    oauth_config: {
      redirect_urls: [input.redirectUrl],
      scopes: {
        bot: [...input.botScopes],
        user: [...input.userScopes],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: input.webhookUrl,
        bot_events: [...input.subscribedEvents],
      },
      interactivity: {
        is_enabled: false,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

/**
 * Build the URL the user opens to start the manifest flow at Slack. The
 * manifest is JSON-stringified and URL-encoded into the query string;
 * Slack's UI parses it and shows a manifest editor pre-populated with our
 * values.
 */
export function buildManifestLaunchUrl(manifest: Record<string, unknown>): string {
  const json = JSON.stringify(manifest);
  const params = new URLSearchParams();
  params.set("new_app", "1");
  params.set("manifest_json", json);
  return `${SLACK_NEW_APP_URL}?${params.toString()}`;
}
