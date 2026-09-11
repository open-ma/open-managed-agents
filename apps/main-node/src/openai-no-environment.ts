import type { SandboxPort } from "@open-managed-agents/sandbox";

class NoEnvironmentSandbox implements SandboxPort {
  async exec(): Promise<string> { throw new Error("No execution environment is selected for this session"); }
  async readFile(): Promise<string> { throw new Error("No execution environment is selected for this session"); }
  async writeFile(): Promise<string> { throw new Error("No execution environment is selected for this session"); }
  async readFileBytes(): Promise<Uint8Array> { throw new Error("No execution environment is selected for this session"); }
  async writeFileBytes(): Promise<string> { throw new Error("No execution environment is selected for this session"); }
}

/** Satisfies the existing harness's SandboxPort dependency without allocating
 * compute, files, credentials, mounts, or a provider connection. */
export const createNoEnvironmentSandbox = (): SandboxPort => new NoEnvironmentSandbox();
export const isNoEnvironmentSandbox = (value: unknown): boolean => value instanceof NoEnvironmentSandbox;
