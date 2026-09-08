import type {
  SuperserveCommandResult,
  SuperserveCreateOptions,
  SuperserveSandboxSdkPort,
} from "../../src/superserve";

const boxes = new Map<string, SuperserveSandboxSdkPort>();

function result(): SuperserveCommandResult {
  return { stdout: "", stderr: "", exitCode: 0, truncated: false };
}

function box(options: SuperserveCreateOptions): SuperserveSandboxSdkPort {
  let status = "active";
  let metadata = { ...(options.metadata ?? {}) };
  const id = `id-${options.name}`;
  return {
    id,
    name: options.name,
    get status() { return status; },
    get metadata() { return metadata; },
    commands: {
      async run() { return result(); },
      async spawn() {
        return {
          stdin: { write() {}, close() {} },
          kill() {},
          async wait() { return result(); },
          async close() {},
        };
      },
    },
    files: {
      async write() {},
      async read() { return new Uint8Array(); },
      async readText() { return ""; },
    },
    async getInfo() { return { id, name: options.name, status, metadata }; },
    async pause() { status = "paused"; },
    async resume() { status = "active"; },
    async kill() { status = "failed"; boxes.delete(id); },
    async update(update) { if (update.metadata !== undefined) metadata = update.metadata; },
    async attachSecret() {},
    async detachSecret() {},
  };
}

export const superserveFixtureCalls: Array<{ type: string; input: unknown }> = [];

export const Sandbox = {
  async create(options: SuperserveCreateOptions) {
    superserveFixtureCalls.push({ type: "create", input: options });
    const value = box(options);
    boxes.set(value.id, value);
    return value;
  },
  async connect(id: string, options?: unknown) {
    superserveFixtureCalls.push({ type: "connect", input: { id, options } });
    const value = boxes.get(id);
    if (value === undefined) throw Object.assign(new Error("not found"), { name: "NotFoundError" });
    return value;
  },
  async list(options?: Record<string, unknown>) {
    superserveFixtureCalls.push({ type: "list", input: options });
    const metadata = (options?.metadata ?? {}) as Record<string, string>;
    return [...boxes.values()].filter((value) => Object.entries(metadata).every(([key, item]) => value.metadata[key] === item))
      .map((value) => ({ id: value.id, name: value.name, status: value.status, metadata: value.metadata }));
  },
  async killById(id: string, options?: unknown) {
    superserveFixtureCalls.push({ type: "kill", input: { id, options } });
    boxes.delete(id);
  },
};
