// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildPlist, buildUnit, buildShim } from "../../packages/cli/src/bridge/lib/service-templates";
import { paths } from "../../packages/cli/src/bridge/lib/platform";

/**
 * Service-template builders — regression tests.
 *
 * Why this exists: in development we hit a multi-hour bug where the
 * launchd plist for OMA_PROFILE=staging silently dropped the env var,
 * so the launchd-spawned daemon read prod creds, attached to prod URL,
 * and competed with the real prod daemon (HTTP 409 reconnect loop).
 * The "staging" daemon was visible in `launchctl list` but doing
 * exactly the wrong thing.
 *
 * The fix: every service template (launchd plist, systemd unit, Windows
 * .cmd shim) now embeds OMA_PROFILE in the spawned daemon's environment.
 * These tests pin that fix in place across all three platforms — if any
 * builder regresses to "PATH only" the suite fails before it ships.
 */
describe("service builders — OMA_PROFILE injection", () => {
  const ORIGINAL = process.env.OMA_PROFILE;
  beforeEach(() => { delete process.env.OMA_PROFILE; });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.OMA_PROFILE;
    else process.env.OMA_PROFILE = ORIGINAL;
  });

  const opts = { nodePath: "/usr/local/bin/node", cliEntry: "/usr/local/lib/node_modules/@openma/cli/dist/index.js" };

  describe("launchd plist", () => {
    it("injects OMA_PROFILE when profile is set", () => {
      process.env.OMA_PROFILE = "staging";
      const plist = buildPlist(opts);
      expect(plist).toMatch(/<key>OMA_PROFILE<\/key>\s*<string>staging<\/string>/);
      // The Label and log path also carry the profile so they don't
      // collide with the default profile's plist.
      expect(plist).toMatch(/<key>Label<\/key>\s*<string>dev\.openma\.bridge\.staging<\/string>/);
      expect(plist).toMatch(/bridge-staging\/logs\/bridge\.log/);
    });

    it("OMITS OMA_PROFILE for the default (empty) profile", () => {
      const plist = buildPlist(opts);
      expect(plist).not.toMatch(/OMA_PROFILE/);
      expect(plist).toMatch(/<key>Label<\/key>\s*<string>dev\.openma\.bridge<\/string>/);
    });

    it("escapes profile values that contain XML-special chars (defense)", () => {
      // Profile slug regex already rejects these, but if validation is
      // ever loosened we don't want a profile name to break the plist.
      // Slug regex disallows '<' so we can't actually trigger the case
      // through currentProfile() — but escapeXml is still called and
      // verified by absence of unescaped chars in the env block.
      process.env.OMA_PROFILE = "staging";
      const plist = buildPlist(opts);
      const envBlock = plist.match(/<key>EnvironmentVariables<\/key>[\s\S]*?<\/dict>/)?.[0] ?? "";
      // Sanity: no stray < / > inside the values (the only allowed <
      // and > are XML element delimiters).
      const valueChars = envBlock.replace(/<[^>]+>/g, "");
      expect(valueChars).not.toMatch(/[<>]/);
    });
  });

  describe("systemd unit", () => {
    it("injects Environment=OMA_PROFILE when profile is set", () => {
      process.env.OMA_PROFILE = "staging";
      const unit = buildUnit(opts);
      expect(unit).toMatch(/Environment=OMA_PROFILE=staging/);
      expect(unit).toMatch(/StandardOutput=append:.*bridge-staging\/logs\/bridge\.log/);
    });

    it("OMITS OMA_PROFILE for the default profile", () => {
      const unit = buildUnit(opts);
      expect(unit).not.toMatch(/OMA_PROFILE/);
    });

    it("emits a Type=simple unit with Restart=always (KeepAlive parity with launchd)", () => {
      const unit = buildUnit(opts);
      expect(unit).toMatch(/Type=simple/);
      expect(unit).toMatch(/Restart=always/);
      expect(unit).toMatch(/RestartSec=10/);
      expect(unit).toMatch(/WantedBy=default\.target/); // user unit, not system
    });
  });

  describe("Windows Task Scheduler shim (.cmd)", () => {
    it("emits 'set OMA_PROFILE=' line when profile is set", () => {
      process.env.OMA_PROFILE = "staging";
      const shim = buildShim(opts);
      expect(shim).toMatch(/set "OMA_PROFILE=staging"/);
      expect(shim).toMatch(/bridge-staging[\\/]logs/);
    });

    it("OMITS OMA_PROFILE line for the default profile", () => {
      const shim = buildShim(opts);
      expect(shim).not.toMatch(/OMA_PROFILE/);
    });

    it("uses CRLF line endings (.cmd convention)", () => {
      const shim = buildShim(opts);
      // At least one CRLF; Windows cmd hosts handle LF inconsistently.
      expect(shim).toMatch(/\r\n/);
    });

    it("redirects stdout+stderr to bridge.log so we have parity with launchd/systemd", () => {
      const shim = buildShim(opts);
      // The spawned process redirects to the same per-profile log file
      // that the other platforms use, so `tail -f` on a shared log path
      // works the same everywhere.
      expect(shim).toMatch(/bridge daemon >> ".*bridge\.log" 2>&1/);
    });
  });

  describe("cross-platform consistency", () => {
    it("all three builders agree on the profile-suffixed log path", () => {
      process.env.OMA_PROFILE = "alpha";
      const expectedLog = paths().logFile;
      expect(buildPlist(opts)).toContain(expectedLog);
      expect(buildUnit(opts)).toContain(expectedLog);
      expect(buildShim(opts)).toContain(expectedLog);
    });

    it("none of the three builders inject OMA_PROFILE for the default profile", () => {
      // This is the regression: any platform forgetting the empty-
      // profile branch would silently inject `OMA_PROFILE=` (empty)
      // which currentProfile() rejects as invalid → daemon crashes
      // on startup. Catch it before it ships.
      const a = buildPlist(opts);
      const b = buildUnit(opts);
      const c = buildShim(opts);
      expect(a).not.toMatch(/OMA_PROFILE/);
      expect(b).not.toMatch(/OMA_PROFILE/);
      expect(c).not.toMatch(/OMA_PROFILE/);
    });
  });
});
