import type {
  VercelGetOrCreateOptions,
  VercelRunCommandInput,
  VercelSandboxSdkPort,
} from "../../src/vercel";

const sandboxes = new Map<string, VercelSandboxSdkPort>();

function sandbox(options: VercelGetOrCreateOptions): VercelSandboxSdkPort {
  let status = "running";
  return {
    name: options.name,
    get status() { return status; },
    persistent: true,
    tags: options.tags,
    currentSnapshotId: undefined,
    async runCommand(input: VercelRunCommandInput) {
      if (input.detached === true) {
        input.stdout?.end();
        input.stderr?.end();
        return { async wait() { return { exitCode: 0 }; }, async kill() {} };
      }
      return { exitCode: 0, async stdout() { return ""; }, async stderr() { return ""; } };
    },
    async mkDir() {},
    async readFileToBuffer() { return Buffer.alloc(0); },
    async writeFiles() {},
    async stop() { status = "stopped"; return {}; },
    async updateNetworkPolicy(policy) { return policy; },
    async delete() { status = "failed"; sandboxes.delete(options.name); },
  } as VercelSandboxSdkPort;
}

export const vercelFixtureCalls: Array<{ type: string; input: unknown }> = [];

export const Sandbox = {
  async getOrCreate(options: VercelGetOrCreateOptions & Record<string, unknown>) {
    vercelFixtureCalls.push({ type: "getOrCreate", input: options });
    const existing = sandboxes.get(options.name);
    if (existing !== undefined) return existing;
    const value = sandbox(options);
    sandboxes.set(options.name, value);
    return value;
  },
  async get(options: { name: string } & Record<string, unknown>) {
    vercelFixtureCalls.push({ type: "get", input: options });
    const value = sandboxes.get(options.name);
    if (value === undefined) throw new Error("not found");
    return value;
  },
};
