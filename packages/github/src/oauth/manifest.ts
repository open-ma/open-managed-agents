// GitHub App Manifest flow helpers.
//
// Reference: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
//
// The manifest flow lets us register a fresh GitHub App for the user with
// zero copy-paste. Three steps:
//
//   1. We generate a manifest JSON (App name, webhook URL, perms, events,
//      etc.) and a short-lived state JWT.
//   2. The user's browser POSTs the manifest to GitHub. GitHub renders a
//      "Create GitHub App for <name>" page; user clicks confirm.
//   3. GitHub redirects to our `redirect_url` with ?code=<temp>&state=<ours>.
//      We exchange the code via POST /app-manifests/{code}/conversions and
//      receive the App's id, slug, private key, webhook secret, and
//      OAuth client credentials — all server-generated, all in one round trip.
//
// This replaces the manual `submit_credentials` path where the user had to
// hand-fill a 10-field GitHub form, download a .pem, and paste 4 secrets back.

const GITHUB_API = "https://api.github.com";

export interface ManifestInput {
  /** Persona-derived App name; GitHub auto-derives the slug from this. */
  name: string;
  /** Public homepage URL. Anything sensible — your project page works. */
  url: string;
  /** Where GitHub POSTs webhooks. We bake the OMA-internal app id into the path. */
  webhookUrl: string;
  /** Where GitHub redirects after manifest creation completes. Carries `?code=&state=`. */
  redirectUrl: string;
  /** Where GitHub redirects after install (Setup URL on the App). */
  setupUrl: string;
  /** Permissions the App needs — see GitHub docs for full key list. */
  permissions: Record<string, string>;
  /** Webhook events the App subscribes to. */
  events: ReadonlyArray<string>;
  /** Whether the App is publicly installable across orgs. Default false. */
  public?: boolean;
}

/**
 * Build the manifest JSON the browser POSTs to github.com/settings/apps/new.
 * Pure function — no I/O.
 */
export function buildManifest(input: ManifestInput): Record<string, unknown> {
  return {
    name: input.name,
    url: input.url,
    hook_attributes: {
      url: input.webhookUrl,
      active: true,
    },
    redirect_url: input.redirectUrl,
    callback_urls: [input.setupUrl],
    setup_url: input.setupUrl,
    setup_on_update: true,
    public: input.public ?? false,
    default_permissions: input.permissions,
    default_events: input.events,
  };
}

/**
 * Build the request that exchanges the manifest `code` for App credentials.
 * Caller POSTs and parses the response.
 *
 * The conversion endpoint is unauthenticated — `code` is the only secret,
 * and GitHub invalidates it on first use (or after ~10 minutes).
 */
export function buildManifestConversionRequest(code: string): {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  body: string;
} {
  return {
    method: "POST",
    url: `${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "open-managed-agents",
    },
    body: "",
  };
}

export interface ManifestConversionResult {
  /** Numeric App ID. */
  id: number;
  slug: string;
  name: string;
  /** Bot user login (`<slug>[bot]`). Derived from slug; GitHub doesn't return it directly. */
  botLogin: string;
  htmlUrl: string;
  /** OAuth client id (only used if the App also serves user-OAuth). */
  clientId: string;
  /** OAuth client secret. */
  clientSecret: string;
  /** Webhook signing secret (server-generated this time, not user-chosen). */
  webhookSecret: string;
  /** PEM-encoded RSA private key. */
  pem: string;
}

export function parseManifestConversionResponse(body: string): ManifestConversionResult {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  const id = parsed.id;
  const slug = parsed.slug;
  const name = parsed.name;
  const pem = parsed.pem;
  const webhookSecret = parsed.webhook_secret;
  if (
    typeof id !== "number" ||
    typeof slug !== "string" ||
    typeof name !== "string" ||
    typeof pem !== "string" ||
    typeof webhookSecret !== "string"
  ) {
    throw new Error(
      `manifest conversion: missing required fields in response: ${body.slice(0, 200)}`,
    );
  }
  return {
    id,
    slug,
    name,
    botLogin: `${slug}[bot]`,
    htmlUrl: (parsed.html_url as string) ?? `https://github.com/apps/${slug}`,
    clientId: (parsed.client_id as string) ?? "",
    clientSecret: (parsed.client_secret as string) ?? "",
    webhookSecret,
    pem,
  };
}
