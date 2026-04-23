import { describe, it, expect } from "vitest";
import {
  buildManifest,
  buildManifestLaunchUrl,
  type SlackManifestInput,
} from "../../packages/slack/src/oauth/manifest";

const baseInput: SlackManifestInput = {
  personaName: "Triage Bot",
  webhookUrl: "https://gw.example/slack/webhook/app/A1",
  redirectUrl: "https://gw.example/slack/oauth/app/A1/callback",
  botScopes: ["app_mentions:read", "chat:write"],
  userScopes: ["search:read.public"],
  subscribedEvents: ["app_mention", "message.channels"],
};

describe("buildManifest", () => {
  it("packs all input fields into Slack's manifest schema", () => {
    const m = buildManifest(baseInput) as Record<string, any>;
    expect(m.display_information.name).toBe("Triage Bot");
    expect(m.features.bot_user.display_name).toBe("Triage Bot");
    expect(m.features.bot_user.always_online).toBe(true);
    expect(m.oauth_config.redirect_urls).toEqual([baseInput.redirectUrl]);
    expect(m.oauth_config.scopes.bot).toEqual([...baseInput.botScopes]);
    expect(m.oauth_config.scopes.user).toEqual([...baseInput.userScopes]);
    expect(m.settings.event_subscriptions.request_url).toBe(baseInput.webhookUrl);
    expect(m.settings.event_subscriptions.bot_events).toEqual([...baseInput.subscribedEvents]);
  });

  it("sets sensible defaults for unrelated settings (no socket mode, no token rotation)", () => {
    const m = buildManifest(baseInput) as Record<string, any>;
    expect(m.settings.socket_mode_enabled).toBe(false);
    expect(m.settings.token_rotation_enabled).toBe(false);
    expect(m.settings.org_deploy_enabled).toBe(false);
    expect(m.settings.interactivity.is_enabled).toBe(false);
  });

  it("derives a default description when none supplied", () => {
    const m = buildManifest(baseInput) as Record<string, any>;
    expect(m.display_information.description).toMatch(/Triage Bot/);
  });

  it("respects an explicit description override", () => {
    const m = buildManifest({ ...baseInput, description: "Custom blurb" }) as Record<string, any>;
    expect(m.display_information.description).toBe("Custom blurb");
  });

  it("enables the AI assistant_view so assistant_thread_started fires", () => {
    const m = buildManifest(baseInput) as Record<string, any>;
    expect(m.features.assistant_view).toBeTruthy();
    expect(m.features.assistant_view.assistant_description).toMatch(/Triage Bot/);
  });
});

describe("buildManifestLaunchUrl", () => {
  it("returns a Slack apps URL with new_app=1 and the manifest as a JSON-encoded query param", () => {
    const url = buildManifestLaunchUrl(buildManifest(baseInput));
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://api.slack.com/apps");
    expect(parsed.searchParams.get("new_app")).toBe("1");
    const m = JSON.parse(parsed.searchParams.get("manifest_json") ?? "");
    expect(m.display_information.name).toBe("Triage Bot");
    expect(m.settings.event_subscriptions.request_url).toBe(baseInput.webhookUrl);
  });

  it("URL-encodes characters safely (parens, quotes, ampersands in app name don't break the URL)", () => {
    const tricky = buildManifest({
      ...baseInput,
      personaName: "AT&T \"Helper\" (beta)",
    });
    const url = buildManifestLaunchUrl(tricky);
    const parsed = new URL(url);
    const m = JSON.parse(parsed.searchParams.get("manifest_json") ?? "");
    expect(m.display_information.name).toBe('AT&T "Helper" (beta)');
  });
});
