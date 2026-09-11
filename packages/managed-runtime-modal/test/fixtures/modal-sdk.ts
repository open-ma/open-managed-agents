import type { ModalProcessPort, ModalSandboxSdkPort } from "../../src/modal";

function textStream() {
  return new ReadableStream<string>({ start(controller) { controller.close(); } });
}

function process(): ModalProcessPort {
  return {
    stdin: new WritableStream<string>(),
    stdout: textStream(),
    stderr: textStream(),
    wait: async () => 0,
  };
}

function sandbox(id: string): ModalSandboxSdkPort {
  let tags: Record<string, string> = {};
  return {
    sandboxId: id,
    filesystem: {
      makeDirectory: async () => undefined,
      readText: async () => "",
      readBytes: async () => new Uint8Array(),
      writeText: async () => undefined,
      writeBytes: async () => undefined,
    },
    exec: async () => process(),
    poll: async () => null,
    getTags: async () => tags,
    setTags: async (value) => { tags = value; },
    updateNetworkPolicy: async () => undefined,
    detach: () => undefined,
    terminate: async () => undefined,
  };
}

const byName = new Map<string, ModalSandboxSdkPort>();
const byId = new Map<string, ModalSandboxSdkPort>();

export const modalFixtureCalls: Array<{ type: string; input: unknown }> = [];
let nextFindError: unknown;

export function failNextModalFixtureFind(error: unknown): void {
  nextFindError = error;
}

export class ModalClient {
  constructor(credentials?: unknown) {
    modalFixtureCalls.push({ type: "credentials", input: credentials });
  }

  readonly apps = {
    fromName: async (name: string, options: unknown) => {
      modalFixtureCalls.push({ type: "app", input: { name, options } });
      return { name };
    },
  };

  readonly images = {
    fromRegistry: (image: string) => {
      modalFixtureCalls.push({ type: "image", input: image });
      return { image };
    },
  };

  readonly volumes = {
    fromName: async (name: string, options: unknown) => ({
      withMountOptions: (mount: unknown) => {
        modalFixtureCalls.push({ type: "volume", input: { name, options, mount } });
        return { name, mount };
      },
    }),
  };

  readonly sandboxes = {
    fromName: async (_appName: string, name: string) => {
      if (nextFindError !== undefined) {
        const error = nextFindError;
        nextFindError = undefined;
        throw error;
      }
      const value = byName.get(name);
      if (value === undefined) throw Object.assign(new Error("not found"), { name: "NotFoundError" });
      return value;
    },
    create: async (_app: unknown, _image: unknown, options: Record<string, unknown>) => {
      const name = String(options.name);
      const value = sandbox(`modal-${name}`);
      await value.setTags(options.tags as Record<string, string>);
      byName.set(name, value);
      byId.set(value.sandboxId, value);
      modalFixtureCalls.push({ type: "create", input: options });
      return value;
    },
    fromId: async (id: string) => {
      const value = byId.get(id);
      if (value === undefined) throw Object.assign(new Error("not found"), { name: "NotFoundError" });
      return value;
    },
  };
}
