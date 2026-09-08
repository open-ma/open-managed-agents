import { PassThrough } from "node:stream";

import type {
  SpriteSdkPort,
  SpritesClientPort,
  SpritesCreateOptions,
} from "../../src/sprites";

const sprites = new Map<string, SpriteSdkPort>();

class FixtureFilesystem {
  constructor(private readonly files: Map<string, Buffer>) {}

  readFile(path: string, encoding: "utf8"): Promise<string>;
  readFile(path: string, encoding?: null): Promise<Buffer>;
  async readFile(path: string, encoding: "utf8" | null = null): Promise<string | Buffer> {
    const value = this.files.get(path) ?? Buffer.alloc(0);
    return encoding === "utf8" ? value.toString("utf8") : value;
  }

  async writeFile(path: string, data: string | Buffer): Promise<void> {
    this.files.set(path, Buffer.isBuffer(data) ? data : Buffer.from(data));
  }

  async mkdir(): Promise<void> {}
}

function createSprite(name: string, options: SpritesCreateOptions = {}): SpriteSdkPort {
  let labels = [...(options.labels ?? [])];
  const files = new Map<string, Buffer>();
  return {
    name,
    id: `id-${name}`,
    status: "running",
    labels,
    filesystem: () => new FixtureFilesystem(files),
    async execFileHTTP() { return { stdout: "", stderr: "", exitCode: 0 }; },
    spawn() {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      return {
        stdin, stdout, stderr,
        async start() { stdout.end(); stderr.end(); },
        async wait() { return 0; },
        kill() {}, close() {},
      };
    },
    async check() { return { status: "running" }; },
    async updateNetworkPolicy() {},
    closeControlConnection() {},
    async delete() { sprites.delete(name); },
  };
}

export const spritesFixtureCalls: Array<{ type: string; input: unknown }> = [];

export class SpritesClient implements SpritesClientPort {
  constructor(token: string, options?: unknown) {
    spritesFixtureCalls.push({ type: "constructor", input: { token, options } });
  }

  async getSprite(name: string): Promise<SpriteSdkPort> {
    const sprite = sprites.get(name);
    if (sprite === undefined) throw Object.assign(new Error("not found"), { statusCode: 404 });
    return sprite;
  }

  async createSprite(name: string, options?: SpritesCreateOptions): Promise<SpriteSdkPort> {
    const sprite = createSprite(name, options);
    sprites.set(name, sprite);
    spritesFixtureCalls.push({ type: "create", input: { name, options } });
    return sprite;
  }

  async deleteSprite(name: string): Promise<void> {
    sprites.delete(name);
  }
}
