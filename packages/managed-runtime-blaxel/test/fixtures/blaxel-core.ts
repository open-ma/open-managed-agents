import type { BlaxelCreateOptions, BlaxelSandboxSdkPort } from "../../src/blaxel";

function processResult() {
  return {
    name: "probe",
    pid: "1",
    status: "completed",
    exitCode: 0,
    stdout: "",
    stderr: "",
  };
}

function makeSandbox(input: BlaxelCreateOptions): BlaxelSandboxSdkPort {
  const instance: BlaxelSandboxSdkPort = {
    metadata: { name: input.name, labels: input.labels, externalId: input.externalId },
    status: "DEPLOYED",
    fs: {
      mkdir: async () => undefined,
      write: async () => undefined,
      writeBinary: async () => undefined,
      read: async () => "",
      readBinary: async () => new Blob(),
    },
    process: {
      exec: async () => processResult(),
      wait: async () => processResult(),
      writeStdin: async () => undefined,
      closeStdin: async () => undefined,
      kill: async () => undefined,
    },
    wait: async () => instance,
    archive: async () => instance,
    unarchive: async () => instance,
    delete: async () => undefined,
  };
  return instance;
}

let last: BlaxelSandboxSdkPort | undefined;

export const SandboxInstance = {
  async createIfNotExists(input: BlaxelCreateOptions) {
    return last ??= makeSandbox(input);
  },
  async get() {
    if (last === undefined) throw new Error("not found");
    return last;
  },
  async delete() {
    last = undefined;
  },
  async updateNetwork() {
    if (last === undefined) throw new Error("not found");
    return last;
  },
};
