import { describe, it, expect } from "vitest";
import { _testInternals } from "../../apps/integrations/src/routes/slack/setup-page";

const { landingPage } = _testInternals;

describe("Slack setup-page landingPage HTML", () => {
  it("includes the manifest 'Create Slack App' button when a launch URL is provided", () => {
    const html = landingPage({
      token: "tok123",
      personaName: "Triage",
      manifestLaunchUrl: "https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D",
    });
    expect(html).toContain("Create Slack App");
    expect(html).toContain("https://api.slack.com/apps?new_app=1&amp;manifest_json=%7B%7D");
    expect(html).toContain("class=\"manifest-btn\"");
  });

  it("collapses the manual setup details when a manifest URL is present", () => {
    const html = landingPage({
      token: "tok123",
      personaName: "Triage",
      manifestLaunchUrl: "https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D",
    });
    // <details> renders without `open` attr → manual section is collapsed
    expect(html).toMatch(/<details>\s*<summary[^>]*>Or set up manually/);
  });

  it("opens the manual setup details when no manifest URL is provided", () => {
    const html = landingPage({
      token: "abc",
      personaName: "Triage",
      manifestLaunchUrl: null,
    });
    expect(html).not.toContain("Create Slack App");
    expect(html).not.toContain("class=\"manifest-btn\"");
    expect(html).toMatch(/<details open>\s*<summary[^>]*>Manual setup steps/);
  });

  it("escapes user-controlled persona name in the visible HTML", () => {
    const html = landingPage({
      token: "abc",
      personaName: '<img src=x onerror=alert(1)>',
      manifestLaunchUrl: null,
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("embeds the formToken as a JSON-string in the JS handler so quotes don't break the script", () => {
    const html = landingPage({
      token: 'tok"with-quote',
      personaName: "Triage",
      manifestLaunchUrl: null,
    });
    // Token is HTML-escaped first, then JSON-stringified for the script.
    expect(html).toMatch(/const TOKEN = "tok&quot;with-quote";/);
  });
});
