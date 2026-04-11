// @ts-nocheck
// Stub for @cloudflare/sandbox in vitest.
// The real module depends on @cloudflare/containers which has workerd-native
// modules that can't load in miniflare. This stub provides the exports
// so index.ts can load without errors during tests.

export class Sandbox {}
export function getSandbox() {
  return {
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0, success: true }),
    readFile: async () => ({ content: "" }),
    writeFile: async () => {},
    mkdir: async () => {},
  };
}
export function proxyToSandbox() {
  return new Response("stub");
}
