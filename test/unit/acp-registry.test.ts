// @ts-nocheck
import { describe, it, expect } from "vitest";
import { OMA_OVERLAY_AGENTS, KNOWN_ACP_AGENTS, resolveKnownAgent } from "../../packages/acp-runtime/src/known-agents";

/**
 * Sanity checks on OMA's overlay over the official ACP registry. Ships
 * to browser bundles + the CF Worker, so missing/broken fields turn into
 * bad UX silently. Easier to catch them here.
 *
 * Real failure modes this guards against:
 *   - copy-paste duplicate ids
 *   - empty install hints surfaced as ".. install: " in setup.ts output
 *   - non-URL homepages turning into a broken link in the Console
 *   - command field empty / whitespace breaking spawn
 *   - alias collisions (one alias maps to multiple canonical entries —
 *     resolution becomes nondeterministic)
 *   - canonical id used as someone else's alias (would silently shadow)
 *   - missing the legacy alias map for ids OMA shipped pre-A2 — would
 *     orphan AgentConfig rows on the production DB
 */
describe("OMA_OVERLAY_AGENTS (browser-safe overlay over the official ACP registry)", () => {
  it("KNOWN_ACP_AGENTS is back-compat alias for OMA_OVERLAY_AGENTS", () => {
    expect(KNOWN_ACP_AGENTS).toBe(OMA_OVERLAY_AGENTS);
  });

  it("includes the canonical ids OMA needs (claude-acp, codex-acp, gemini, opencode, hermes, openclaw)", () => {
    const ids = new Set(OMA_OVERLAY_AGENTS.map((e) => e.id));
    for (const id of ["claude-acp", "codex-acp", "gemini", "opencode", "hermes", "openclaw"]) {
      expect(ids.has(id), `missing overlay entry: ${id}`).toBe(true);
    }
  });

  it("ids are unique slugs", () => {
    const ids = OMA_OVERLAY_AGENTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id, `id "${id}" must be slug-only`).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  it("each entry has a non-empty label, command, install hint, and homepage URL", () => {
    for (const e of OMA_OVERLAY_AGENTS) {
      expect(e.label?.trim(), `${e.id}.label`).toBeTruthy();
      expect(e.spec?.command?.trim(), `${e.id}.spec.command`).toBeTruthy();
      expect(e.spec.command, `${e.id}.spec.command must have no whitespace`)
        .not.toMatch(/\s/);
      expect(e.installHint?.trim(), `${e.id}.installHint`).toBeTruthy();
      expect(e.homepage, `${e.id}.homepage`).toMatch(/^https?:\/\//);
    }
  });

  it("args (if present) are a non-empty array of non-empty strings", () => {
    for (const e of OMA_OVERLAY_AGENTS) {
      if (!e.spec.args) continue;
      expect(Array.isArray(e.spec.args)).toBe(true);
      expect(e.spec.args.length).toBeGreaterThan(0);
      for (const a of e.spec.args) {
        expect(typeof a).toBe("string");
        expect(a.trim()).toBeTruthy();
      }
    }
  });

  it("aliases never collide with another entry's id or alias", () => {
    const allIds = OMA_OVERLAY_AGENTS.map((e) => e.id);
    for (const e of OMA_OVERLAY_AGENTS) {
      for (const alias of e.aliases ?? []) {
        // alias can't equal another canonical id
        expect(allIds.includes(alias) && alias !== e.id, `alias "${alias}" collides with canonical id`)
          .toBe(false);
        // alias can't collide with another entry's alias
        const collisions = OMA_OVERLAY_AGENTS.filter(
          (other) => other !== e && (other.aliases ?? []).includes(alias),
        );
        expect(collisions.length, `alias "${alias}" appears on multiple entries`).toBe(0);
      }
    }
  });

  it("carries pre-A2 legacy aliases for ids OMA used to ship", () => {
    // These are the ids OMA hardcoded before adopting the official
    // registry. AgentConfig rows in the prod DB still reference them;
    // dropping the alias map would 500 every spawn.
    const legacyToCanonical: Record<string, string> = {
      "claude-agent-acp": "claude-acp",
      "claude-code-acp": "claude-acp",
      "codex-cli": "codex-acp",
      "codex-acp-bridge": "codex-acp",
      "gemini-cli": "gemini",
    };
    for (const [legacy, canonical] of Object.entries(legacyToCanonical)) {
      const e = resolveKnownAgent(legacy);
      expect(e?.id, `legacy id "${legacy}" should resolve to canonical "${canonical}"`)
        .toBe(canonical);
    }
  });
});

describe("resolveKnownAgent (overlay-only sync resolver)", () => {
  it("resolves canonical ids to their entry", () => {
    expect(resolveKnownAgent("claude-acp")?.id).toBe("claude-acp");
    expect(resolveKnownAgent("opencode")?.id).toBe("opencode");
    expect(resolveKnownAgent("hermes")?.id).toBe("hermes");
  });

  it("resolves legacy aliases to the current canonical entry", () => {
    expect(resolveKnownAgent("claude-agent-acp")?.id).toBe("claude-acp");
    expect(resolveKnownAgent("claude-code-acp")?.id).toBe("claude-acp");
    expect(resolveKnownAgent("codex-cli")?.id).toBe("codex-acp");
    expect(resolveKnownAgent("gemini-cli")?.id).toBe("gemini");
  });

  it("returns null for unknown ids", () => {
    expect(resolveKnownAgent("not-a-real-agent")).toBeNull();
    expect(resolveKnownAgent("")).toBeNull();
  });
});

