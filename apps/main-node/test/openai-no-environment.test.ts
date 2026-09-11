import { describe, expect, it } from "vitest";
import { createNoEnvironmentSandbox, isNoEnvironmentSandbox } from "../src/openai-no-environment";

describe("OpenAI none environment uses no compute resource", () => {
  it("denies filesystem and process execution through the existing SandboxPort", async () => {
    const sandbox = createNoEnvironmentSandbox();
    expect(isNoEnvironmentSandbox(sandbox)).toBe(true);
    expect(isNoEnvironmentSandbox({})).toBe(false);
    await expect(sandbox.exec("touch should-not-exist")).rejects.toThrow("No execution environment");
    await expect(sandbox.readFile("/workspace/a")).rejects.toThrow("No execution environment");
    await expect(sandbox.writeFile("/workspace/a", "x")).rejects.toThrow("No execution environment");
    await expect(sandbox.readFileBytes!("/workspace/a")).rejects.toThrow("No execution environment");
    await expect(sandbox.writeFileBytes!("/workspace/a", new Uint8Array())).rejects.toThrow("No execution environment");
    expect(sandbox.startProcess).toBeUndefined();
  });
});
