import { describe, expect, it } from "vitest";

import { resolveOverlayAgent } from "./known-agents.js";

describe("Harbor agent ACP adapters", () => {
  it.each([
    ["aider", "aider-acp", []],
    ["kimi-code", "kimi", ["acp"]],
    ["mimo", "mimo", ["acp"]],
  ])("registers %s as an ACP process", (id, command, args) => {
    const entry = resolveOverlayAgent(id);
    expect(entry?.id).toBe(id);
    expect(entry?.spec.command).toBe(command);
    expect(entry?.spec.args ?? []).toEqual(args);
    expect(entry?.installHint).toEqual(expect.any(String));
  });

  it("does not silently turn the Aider bridge into an upstream Aider binary", () => {
    const aider = resolveOverlayAgent("aider");
    expect(aider?.spec.command).toBe("aider-acp");
    expect(aider?.spec.command).not.toBe("aider");
  });
});
