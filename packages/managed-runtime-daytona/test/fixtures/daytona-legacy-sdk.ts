import type { DaytonaClientPort, DaytonaSandboxSdkPort } from "../../src/daytona";

export class Daytona implements DaytonaClientPort {
  readonly #sandboxes = new Map<string, DaytonaSandboxSdkPort>();

  constructor(_input: Record<string, unknown>) {}

  async get(idOrName: string) {
    const value = this.#sandboxes.get(idOrName);
    if (value === undefined) throw Object.assign(new Error("not found"), { statusCode: 404 });
    return value;
  }

  async create(input: Readonly<Record<string, unknown>>) {
    const name = String(input.name);
    const value: DaytonaSandboxSdkPort = {
      id: `legacy-${name}`,
      name,
      state: "started",
      labels: input.labels as Record<string, string>,
      fs: {
        uploadFile: async () => undefined,
        downloadFile: async () => new Uint8Array(),
        createFolder: async () => undefined,
      },
      process: {
        executeCommand: async () => ({ exitCode: 0 }),
        createSession: async () => undefined,
        executeSessionCommand: async () => ({ cmdId: "command" }),
        getSessionCommandLogs: async () => undefined,
        getSessionCommand: async () => ({ id: "command", command: "worker", exitCode: 0 }),
        sendSessionCommandInput: async () => undefined,
        deleteSession: async () => undefined,
      },
      refreshData: async () => undefined,
      refreshActivity: async () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      delete: async () => undefined,
      setLabels: async () => undefined,
    };
    this.#sandboxes.set(name, value);
    return value;
  }
}
