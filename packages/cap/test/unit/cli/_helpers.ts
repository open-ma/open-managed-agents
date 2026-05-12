// Per-CLI integration tests — drive the full registry → handle stack with
// realistic inputs and assert the wire output matches what each upstream
// expects. These are the "smoke tests for the public API" — failures here
// indicate a mismatch between the spec and the real-world CLI's wire
// protocol (e.g. wrong header name, wrong endpoint, wrong JSON envelope).
//
// This file is shared helpers; tests live in <cli>.test.ts.

import { builtinSpecs } from "../../../src/builtin";
import { createSpecRegistry } from "../../../src/registry";
import { FakeResolver, ManualClock, SilentLogger } from "../../../src/test-fakes";
import type { HttpReqLike } from "../../../src/types";
import type { ResolveInput } from "../../../src/ports";

export const NOW_MS = Date.UTC(2026, 4, 9, 12, 0, 0);

export function buildDeps() {
  return {
    resolver: new FakeResolver(),
    registry: createSpecRegistry(builtinSpecs),
    clock: new ManualClock(NOW_MS),
    logger: new SilentLogger(),
  };
}

export function get(url: string, headers: Record<string, string> = {}): HttpReqLike {
  return { url, method: "GET", headers, body: null };
}

export function setTok(
  resolver: FakeResolver,
  cli_id: string,
  hostname: string,
  token: string,
  extras?: Record<string, string>,
  expires_at?: number,
): ResolveInput {
  const input = { principal: "p1", cli_id, hostname };
  resolver.set(input, {
    token,
    ...(expires_at !== undefined ? { expires_at } : {}),
    ...(extras ? { extras } : {}),
  });
  return input;
}
