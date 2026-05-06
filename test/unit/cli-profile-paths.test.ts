// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { paths, currentProfile } from "../../packages/cli/src/bridge/lib/platform";

/**
 * The bridge daemon's path layout MUST stay byte-identical for users
 * who never set OMA_PROFILE — the profile system is opt-in, and breaking
 * the default would orphan every existing prod creds file in the field.
 *
 * For named profiles we want clean isolation: configDir, sessions, log,
 * and launchd Label all carry the suffix so two daemons don't fight
 * over the same files or the same launchd registration.
 */
describe("currentProfile / paths() — profile isolation", () => {
  const ORIGINAL = process.env.OMA_PROFILE;
  beforeEach(() => { delete process.env.OMA_PROFILE; });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.OMA_PROFILE;
    else process.env.OMA_PROFILE = ORIGINAL;
  });

  it("default profile is empty and paths match the pre-profile layout", () => {
    expect(currentProfile()).toBe("");
    const p = paths();
    expect(p.configDir).toBe(join(homedir(), ".oma/bridge"));
    expect(p.credsFile).toBe(join(homedir(), ".oma/bridge", "credentials.json"));
    expect(p.sessionsDir).toBe(join(homedir(), ".oma/bridge", "sessions"));
    expect(p.logFile).toBe(join(homedir(), ".oma/bridge", "logs", "bridge.log"));
    expect(p.serviceLabel).toBe("dev.openma.bridge");
    // Service file path is platform-specific; just check the label baked in.
    if (p.serviceFile) {
      expect(p.serviceFile.endsWith("dev.openma.bridge.plist") ||
             p.serviceFile.endsWith("dev.openma.bridge.service")).toBe(true);
    }
  });

  it("named profile suffixes configDir and serviceLabel without changing the rest", () => {
    process.env.OMA_PROFILE = "staging";
    expect(currentProfile()).toBe("staging");
    const p = paths();
    expect(p.configDir).toBe(join(homedir(), ".oma/bridge-staging"));
    expect(p.credsFile).toBe(join(homedir(), ".oma/bridge-staging", "credentials.json"));
    expect(p.sessionsDir).toBe(join(homedir(), ".oma/bridge-staging", "sessions"));
    expect(p.logFile).toBe(join(homedir(), ".oma/bridge-staging", "logs", "bridge.log"));
    expect(p.serviceLabel).toBe("dev.openma.bridge.staging");
    if (p.serviceFile) {
      expect(p.serviceFile.endsWith("dev.openma.bridge.staging.plist") ||
             p.serviceFile.endsWith("dev.openma.bridge.staging.service")).toBe(true);
    }
  });

  it("two profiles produce no overlapping paths", () => {
    process.env.OMA_PROFILE = "alpha";
    const a = paths();
    process.env.OMA_PROFILE = "beta";
    const b = paths();
    // Every file/dir must be different between profiles — co-existence
    // depends on this. If any field collides, two daemons will stomp.
    expect(a.configDir).not.toBe(b.configDir);
    expect(a.credsFile).not.toBe(b.credsFile);
    expect(a.machineIdFile).not.toBe(b.machineIdFile);
    expect(a.sessionsDir).not.toBe(b.sessionsDir);
    expect(a.logFile).not.toBe(b.logFile);
    expect(a.serviceLabel).not.toBe(b.serviceLabel);
    if (a.serviceFile && b.serviceFile) {
      expect(a.serviceFile).not.toBe(b.serviceFile);
    }
  });

  it("rejects invalid profile slugs at parse time", () => {
    // Uppercase, spaces, dots — anything that could land in a path or
    // launchd Label and surprise the user. Throw early with a clear msg.
    for (const bad of ["Staging", "stag ing", "stag.ing", "stag/ing", "../etc",
                       "-leading", "trailing-", "way-too-long-".repeat(5)]) {
      process.env.OMA_PROFILE = bad;
      expect(() => currentProfile(), `should reject "${bad}"`).toThrow(/not a valid profile slug/);
    }
  });

  it("trims whitespace from OMA_PROFILE (env vars often pick up stray spaces)", () => {
    process.env.OMA_PROFILE = "  staging  ";
    expect(currentProfile()).toBe("staging");
    expect(paths().serviceLabel).toBe("dev.openma.bridge.staging");
  });

  it("treats empty / whitespace-only OMA_PROFILE as default", () => {
    process.env.OMA_PROFILE = "";
    expect(currentProfile()).toBe("");
    expect(paths().serviceLabel).toBe("dev.openma.bridge");
    process.env.OMA_PROFILE = "   ";
    expect(currentProfile()).toBe("");
    expect(paths().serviceLabel).toBe("dev.openma.bridge");
  });
});
