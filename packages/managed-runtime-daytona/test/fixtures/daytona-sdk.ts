import type { DaytonaClientPort, DaytonaSandboxSdkPort } from "../../src/daytona";

function sandbox(input: Record<string, unknown>): DaytonaSandboxSdkPort {
  const value: DaytonaSandboxSdkPort = {
    id: `sdk-${String(input.name)}`,
    name: String(input.name),
    state: "started",
    labels: input.labels as Record<string, string>,
    fs: {
      uploadFile: async () => undefined,
      downloadFile: async () => new Uint8Array(),
      createFolder: async () => undefined,
    },
    process: {
      executeCommand: async () => ({ exitCode: 0, result: "" }),
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
  return value;
}

export const fixtureConstructorInputs: Record<string, unknown>[] = [];

export class Daytona implements DaytonaClientPort {
  readonly #sandboxes = new Map<string, DaytonaSandboxSdkPort>();

  constructor(input: Record<string, unknown>) {
    fixtureConstructorInputs.push(input);
  }

  async get(idOrName: string) {
    const value = this.#sandboxes.get(idOrName)
      ?? [...this.#sandboxes.values()].find((candidate) => candidate.id === idOrName);
    if (value === undefined) throw Object.assign(new Error("not found"), { statusCode: 404 });
    return value;
  }

  async create(input: Readonly<Record<string, unknown>>) {
    const value = sandbox({ ...input });
    this.#sandboxes.set(value.name, value);
    return value;
  }
}
