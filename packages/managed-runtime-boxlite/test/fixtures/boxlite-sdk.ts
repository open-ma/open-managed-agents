import type {
  BoxLiteBoxSdkPort,
  BoxLiteClientPort,
  BoxLiteCreateOptions,
  BoxLiteExecutionPort,
} from "../../src/boxlite";

export const fixtureCalls: Array<{ type: string; input?: unknown }> = [];
const boxes = new Map<string, BoxLiteBoxSdkPort>();

function output() {
  return { async next() { return null; } };
}

function execution(): BoxLiteExecutionPort {
  return {
    id: async () => "execution",
    stdin: async () => ({ write: async () => undefined, close: async () => undefined }),
    stdout: async () => output(),
    stderr: async () => output(),
    wait: async () => ({ exitCode: 0 }),
    kill: async () => undefined,
  };
}

function box(name: string): BoxLiteBoxSdkPort {
  let running = false;
  return {
    id: `box-${name}`,
    name,
    info: () => ({ id: `box-${name}`, name, state: { status: running ? "Running" : "Stopped", running } }),
    exec: async () => execution(),
    start: async () => { running = true; },
    stop: async () => { running = false; },
    copyIn: async () => undefined,
    copyOut: async () => undefined,
  };
}

export class JsBoxlite implements BoxLiteClientPort {
  constructor(options?: { homeDir?: string }) {
    fixtureCalls.push({ type: "constructor", input: options });
  }

  static withDefaultConfig() {
    fixtureCalls.push({ type: "default" });
    return new JsBoxlite();
  }

  static rest(options: unknown) {
    fixtureCalls.push({ type: "rest", input: options });
    return new JsBoxlite();
  }

  async getOrCreate(_options: BoxLiteCreateOptions, name?: string | null) {
    const identity = name ?? "unnamed";
    let value = boxes.get(identity);
    const created = value === undefined;
    value ??= box(identity);
    boxes.set(identity, value);
    return { created, box: value };
  }

  async get(idOrName: string) {
    return boxes.get(idOrName) ?? [...boxes.values()].find((value) => value.id === idOrName) ?? null;
  }

  async remove(idOrName: string) {
    for (const [name, value] of boxes) {
      if (name === idOrName || value.id === idOrName) boxes.delete(name);
    }
  }
}
