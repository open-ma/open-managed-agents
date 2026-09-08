import { describe, expect, it, vi } from "vitest";
import { InMemoryBlobStore } from "@open-managed-agents/blob-store/adapters/in-memory";
import type { BlobObject, BlobStore } from "@open-managed-agents/blob-store/ports";
import type {
  CredentialEgressBinding,
  SessionOutputBinding,
  SessionOutputEntryCandidate,
} from "@open-managed-agents/runtime-resource-contract";

import {
  binding,
  composition,
  fence,
  plan,
  process,
  provider,
  runtime,
  scope,
  stream,
  type TestRuntime,
} from "./provider-runtime-fixture";

async function outputFixture(input: {
  runtime?: TestRuntime;
  store?: BlobStore;
  outputOptions?: Record<string, unknown>;
  strategy?: "final_collect" | "durable_mount";
}) {
  const live = input.runtime ?? runtime("output-runtime");
  const store = input.store ?? new InMemoryBlobStore();
  const selected = provider(live);
  const composed = composition(selected, {
    outputs: {
      store,
      ...(input.outputOptions ?? {}),
    },
  });
  const strategy = input.strategy ?? "final_collect";
  const outputs = await composed.outputs.prepare({
    scope,
    fence,
    strategy,
    idempotencyKey: `prepare-${strategy}`,
    signal: new AbortController().signal,
  });
  const workspace = await binding(composed);
  const sandbox = await composed.sandbox.acquire({
    scope,
    fence,
    plan: { ...plan, outputStrategy: strategy },
    workspace,
    outputs,
    signal: new AbortController().signal,
  });
  return { live, store, selected, composed, outputs, workspace, sandbox };
}

function findRuntime(paths: Uint8Array, files: ReadonlyMap<string, Uint8Array>): TestRuntime {
  return runtime("find-runtime", {
    spawnDuplexProcess: vi.fn(async (spec) =>
      spec.command === "find"
        ? process({ stdout: stream(paths) })
        : process()
    ),
    readFileBytes: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    }),
  });
}

async function attachFinal(fixture: Awaited<ReturnType<typeof outputFixture>>) {
  await fixture.composed.outputs.attach({
    scope,
    fence,
    strategy: "final_collect",
    binding: fixture.outputs,
    sandbox: fixture.sandbox,
    signal: new AbortController().signal,
  });
}

async function collect(fixture: Awaited<ReturnType<typeof outputFixture>>) {
  return fixture.composed.outputs.collect({
    scope,
    fence,
    strategy: "final_collect",
    binding: fixture.outputs,
    signal: new AbortController().signal,
  });
}

async function finalize(
  fixture: Awaited<ReturnType<typeof outputFixture>>,
  entries: readonly SessionOutputEntryCandidate[],
) {
  return fixture.composed.outputs.finalize({
    scope,
    fence,
    strategy: "final_collect",
    binding: fixture.outputs,
    entries,
    idempotencyKey: "finalize",
    signal: new AbortController().signal,
  });
}

describe("provider Session output semantics", () => {
  it("reports disabled, final-collect, and durable-mount capabilities", async () => {
    await expect(composition().outputs.capabilities(scope)).resolves.toEqual({ strategies: [] });

    const store = new InMemoryBlobStore();
    const durableAttach = vi.fn(async () => {});
    const composed = composition(provider(), {
      outputs: {
        store,
        durability: "best_effort",
        durableMount: { attach: durableAttach },
      },
    });
    await expect(composed.outputs.capabilities(scope)).resolves.toEqual({
      strategies: [
        { strategy: "durable_mount", durability: "durable" },
        { strategy: "final_collect", durability: "best_effort" },
      ],
    });
    const bestEffortMount = composition(provider(), {
      outputs: {
        store,
        durableMount: { durability: "best_effort", attach: durableAttach },
      },
    });
    await expect(bestEffortMount.outputs.capabilities(scope)).resolves.toEqual({
      strategies: [
        { strategy: "durable_mount", durability: "best_effort" },
        { strategy: "final_collect", durability: "durable" },
      ],
    });
  });

  it("fails closed when output storage or the selected strategy is unavailable", async () => {
    const disabled = composition();
    await expect(disabled.outputs.prepare({
      scope,
      fence,
      strategy: "final_collect",
      idempotencyKey: "disabled",
      signal: new AbortController().signal,
    })).rejects.toThrow(/no Session output store/i);

    const noMount = composition(provider(), { outputs: { store: new InMemoryBlobStore() } });
    await expect(noMount.outputs.capabilities(scope)).resolves.toEqual({
      strategies: [{ strategy: "final_collect", durability: "durable" }],
    });
    await expect(noMount.outputs.prepare({
      scope,
      fence,
      strategy: "durable_mount",
      idempotencyKey: "no-mount",
      signal: new AbortController().signal,
    })).rejects.toThrow(/do not support durable_mount/i);

    await expect(disabled.outputs.attach({
      scope,
      fence,
      strategy: "final_collect",
      binding: { bindingId: "forged", mountPath: "/mnt/session/outputs" },
      sandbox: { provider: "e2b", runtimeId: "forged" },
      signal: new AbortController().signal,
    })).rejects.toThrow(/no Session output store/i);
  });

  it("attaches a provider-native durable mount and observes cancellation after the wire point", async () => {
    const controller = new AbortController();
    const reason = new Error("fenced after mount");
    const durableAttach = vi.fn(async () => {
      controller.abort(reason);
    });
    const fixture = await outputFixture({
      strategy: "durable_mount",
      outputOptions: { durableMount: { attach: durableAttach } },
    });
    await expect(fixture.composed.outputs.attach({
      scope,
      fence,
      strategy: "durable_mount",
      binding: fixture.outputs,
      sandbox: fixture.sandbox,
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(durableAttach).toHaveBeenCalledWith(expect.objectContaining({
      runtime: fixture.live,
      binding: fixture.outputs,
    }));
  });

  it("rejects a forged durable binding when no provider mount exists", async () => {
    const store = new InMemoryBlobStore();
    const live = runtime("no-durable-attach");
    const composed = composition(provider(live), { outputs: { store } });
    const outputs: SessionOutputBinding = {
      bindingId: "forged-durable",
      mountPath: "/mnt/session/outputs",
    };
    const workspace = await binding(composed);
    const sandbox = await composed.sandbox.acquire({
      scope,
      fence,
      plan: { ...plan, outputStrategy: "durable_mount" },
      workspace,
      outputs,
      signal: new AbortController().signal,
    });
    await expect(composed.outputs.attach({
      scope,
      fence,
      strategy: "durable_mount",
      binding: outputs,
      sandbox,
      signal: new AbortController().signal,
    })).rejects.toThrow(/no durable Session output mount/i);
  });

  it("requires duplex process support for final collection setup", async () => {
    const live = runtime("no-duplex", { spawnDuplexProcess: undefined });
    const fixture = await outputFixture({ runtime: live });
    await expect(attachFinal(fixture)).rejects.toThrow(/requires a duplex process Port/i);
  });

  it("rejects a failed output helper process", async () => {
    const live = runtime("failed-helper", {
      spawnDuplexProcess: vi.fn(async () => process({
        exited: Promise.resolve({ code: 23, signal: null }),
      })),
    });
    const fixture = await outputFixture({ runtime: live });
    await expect(attachFinal(fixture)).rejects.toThrow(/mkdir exited with code 23/i);
  });

  it("kills an output helper when its claim is aborted and ignores kill transport failure", async () => {
    let resolveExit!: (exit: { code: number | null; signal: string | null }) => void;
    let markSpawned!: () => void;
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      resolveExit = resolve;
    });
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    const child = process({
      exited,
      kill: vi.fn(async () => {
        throw new Error("kill transport failed");
      }),
    });
    const live = runtime("aborted-helper", {
      spawnDuplexProcess: vi.fn(async () => {
        markSpawned();
        return child;
      }),
    });
    const fixture = await outputFixture({ runtime: live });
    const controller = new AbortController();
    const reason = new Error("claim fenced");
    const attaching = fixture.composed.outputs.attach({
      scope,
      fence,
      strategy: "final_collect",
      binding: fixture.outputs,
      sandbox: fixture.sandbox,
      signal: controller.signal,
    });
    await spawned;
    await Promise.resolve();
    controller.abort(reason);
    resolveExit({ code: null, signal: "SIGTERM" });
    await expect(attaching).rejects.toBe(reason);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("requires an attached binding and binary reads before collecting", async () => {
    const composed = composition(provider(), { outputs: { store: new InMemoryBlobStore() } });
    await expect(composed.outputs.collect({
      scope,
      fence,
      strategy: "final_collect",
      binding: { bindingId: "unknown", mountPath: "/mnt/session/outputs" },
      signal: new AbortController().signal,
    })).rejects.toThrow(/not attached to a runtime/i);

    const fixture = await outputFixture({
      runtime: runtime("no-binary-read", { readFileBytes: undefined }),
    });
    await expect(collect(fixture)).rejects.toThrow(/requires binary file reads/i);
  });

  it("rejects non-UTF8 output listings and configured file/byte limits", async () => {
    const invalid = await outputFixture({ runtime: findRuntime(new Uint8Array([255]), new Map()) });
    await expect(collect(invalid)).rejects.toThrow(/path is not valid UTF-8/i);

    const encoder = new TextEncoder();
    const twoPaths = encoder.encode(
      "/mnt/session/outputs/a\0/mnt/session/outputs/b\0",
    );
    const tooMany = await outputFixture({
      runtime: findRuntime(twoPaths, new Map()),
      outputOptions: { maxFiles: 1 },
    });
    await expect(collect(tooMany)).rejects.toThrow(/file limit exceeded \(1\)/i);

    const path = "/mnt/session/outputs/large";
    const tooLarge = await outputFixture({
      runtime: findRuntime(encoder.encode(`${path}\0`), new Map([[path, new Uint8Array([1, 2])]])),
      outputOptions: { maxBytes: 1 },
    });
    await expect(collect(tooLarge)).rejects.toThrow(/byte limit exceeded \(1\)/i);
  });

  it.each([
    "/tmp/escaped",
    "/mnt/session/outputs/",
    "/mnt/session/outputs//absolute",
    "/mnt/session/outputs/a//b",
    "/mnt/session/outputs/a/./b",
    "/mnt/session/outputs/a/../b",
  ])("rejects unsafe output path %s", async (path) => {
    const encoded = new TextEncoder().encode(`${path}\0`);
    const fixture = await outputFixture({
      runtime: findRuntime(encoded, new Map([[path, new Uint8Array([1])]])),
    });
    await expect(collect(fixture)).rejects.toThrow(/escaped its mount|unsafe logical path/i);
  });

  it("fails closed before finalization when storage or attachment is missing", async () => {
    await expect(composition().outputs.finalize({
      scope,
      fence,
      strategy: "final_collect",
      binding: { bindingId: "x", mountPath: "/mnt/session/outputs" },
      entries: [],
      idempotencyKey: "disabled",
      signal: new AbortController().signal,
    })).rejects.toThrow(/no Session output store/i);

    const unattached = composition(provider(), { outputs: { store: new InMemoryBlobStore() } });
    await expect(unattached.outputs.finalize({
      scope,
      fence,
      strategy: "final_collect",
      binding: { bindingId: "x", mountPath: "/mnt/session/outputs" },
      entries: [],
      idempotencyKey: "unattached",
      signal: new AbortController().signal,
    })).rejects.toThrow(/not attached to a runtime/i);

    const noBytes = await outputFixture({
      runtime: runtime("finalize-no-bytes", { readFileBytes: undefined }),
    });
    await expect(finalize(noBytes, [])).rejects.toThrow(/finalization requires binary file reads/i);
  });

  it.each(["", "/", "safe/../escaped"])("rejects unsafe output prefix %j", async (keyPrefix) => {
    const fixture = await outputFixture({ outputOptions: { keyPrefix } });
    await expect(finalize(fixture, [])).rejects.toThrow(/safe non-empty blob prefix/i);
  });

  it("supports a scope-derived output prefix", async () => {
    const fixture = await outputFixture({
      outputOptions: { keyPrefix: (value: typeof scope) => `/tenant/${value.workspaceId}/` },
    });
    const manifest = await finalize(fixture, []);
    expect(manifest.metadata?.manifestKey).toMatch(/^tenant\/workspace_1\/manifests\//);
  });

  it("rejects a disappeared blob after an if-none-match collision", async () => {
    const bytes = new TextEncoder().encode("value");
    const path = "/mnt/session/outputs/value.txt";
    const store = new InMemoryBlobStore();
    vi.spyOn(store, "put").mockResolvedValue(null);
    vi.spyOn(store, "get").mockResolvedValue(null);
    const fixture = await outputFixture({
      runtime: findRuntime(new TextEncoder().encode(`${path}\0`), new Map([[path, bytes]])),
      store,
    });
    const entries = await collect(fixture);
    await expect(finalize(fixture, entries)).rejects.toThrow(/existing Session output blob is invalid/i);
  });

  it("rejects a size-mismatched blob after an if-none-match collision", async () => {
    const bytes = new TextEncoder().encode("value");
    const path = "/mnt/session/outputs/value.txt";
    const store = new InMemoryBlobStore();
    const get = store.get.bind(store);
    await store.put("wrong", "x");
    const wrong = await get("wrong");
    vi.spyOn(store, "put").mockResolvedValue(null);
    vi.spyOn(store, "get").mockResolvedValue(wrong);
    const fixture = await outputFixture({
      runtime: findRuntime(new TextEncoder().encode(`${path}\0`), new Map([[path, bytes]])),
      store,
    });
    const entries = await collect(fixture);
    await expect(finalize(fixture, entries)).rejects.toThrow(/existing Session output blob is invalid/i);
  });

  it.each([null, "wrong-manifest"])(
    "rejects a conflicting output manifest value %#",
    async (existingText) => {
      const store = new InMemoryBlobStore();
      const put = store.put.bind(store);
      vi.spyOn(store, "put").mockImplementation(async (key, body, options) =>
        key.includes("/manifests/") ? null : put(key, body, options)
      );
      vi.spyOn(store, "get").mockImplementation(async (key) => {
        if (!key.includes("/manifests/")) return null;
        if (existingText === null) return null;
        return {
          etag: "wrong",
          size: existingText.length,
          body: stream(new TextEncoder().encode(existingText)),
          text: async () => existingText,
          arrayBuffer: async () => new ArrayBuffer(0),
          bytes: async () => new Uint8Array(),
        } satisfies BlobObject;
      });
      const fixture = await outputFixture({ store });
      await expect(finalize(fixture, [])).rejects.toThrow(/existing Session output manifest is invalid/i);
    },
  );

  it("release and abort both detach output bindings", async () => {
    const released = await outputFixture({});
    await released.composed.outputs.release({ scope, fence, binding: released.outputs });
    await expect(collect(released)).rejects.toThrow(/not attached/i);

    const aborted = await outputFixture({});
    await aborted.composed.outputs.abort({
      scope,
      fence,
      binding: aborted.outputs,
      reason: "lease_lost",
    });
    await expect(collect(aborted)).rejects.toThrow(/not attached/i);
  });
});

describe("provider credential egress fencing", () => {
  function egressComposition(live = runtime("egress-runtime"), enforcement: "enforced" | "unsupported" = "enforced") {
    const attach = vi.fn(async () => {});
    const revoke = vi.fn(async () => {});
    return {
      live,
      attach,
      revoke,
      composed: composition(provider(live), {
        credentialEgress: {
          capabilities: {
            enforcement,
            credentialMode: enforcement === "unsupported" ? "snapshot" : "live",
            interceptedProtocols: enforcement === "unsupported" ? [] : ["http", "https"],
          },
          attach,
          revoke,
        },
      }),
    };
  }

  async function prepareEgress(composed: ReturnType<typeof composition>) {
    return composed.credentialEgress!.prepare({
      scope,
      fence,
      requirement: "required",
      idempotencyKey: "egress",
      signal: new AbortController().signal,
    }) as Promise<CredentialEgressBinding>;
  }

  it("returns no binding when provider egress enforcement is unsupported", async () => {
    const { composed } = egressComposition(runtime("unsupported-egress"), "unsupported");
    await expect(prepareEgress(composed)).resolves.toBeNull();
  });

  it("rejects unknown egress bindings before allocating provider compute", async () => {
    const selected = provider(runtime("must-not-leak"));
    const composed = composition(selected, {
      credentialEgress: {
        capabilities: {
          enforcement: "enforced",
          credentialMode: "live",
          interceptedProtocols: ["https"],
        },
        attach: vi.fn(async () => {}),
        revoke: vi.fn(async () => {}),
      },
    });
    const workspace = await binding(composed);
    await expect(composed.sandbox.acquire({
      scope,
      fence,
      plan,
      workspace,
      outputs: null,
      credentialEgress: {
        bindingId: "unknown",
        enforcement: "enforced",
        credentialMode: "live",
      },
      signal: new AbortController().signal,
    })).rejects.toThrow(/binding is unknown/i);
    expect(selected.create).not.toHaveBeenCalled();
  });

  it("rejects cross-scope attach/release and revoke-before-allocation", async () => {
    const { composed } = egressComposition();
    const prepared = await prepareEgress(composed);
    const otherScope = { ...scope, sessionId: "session_2" };
    const otherFence = { ...fence, ...otherScope };
    await expect(composed.credentialEgress!.attach({
      scope: otherScope,
      fence: otherFence,
      binding: prepared,
      sandbox: { provider: "e2b", runtimeId: "missing" },
      signal: new AbortController().signal,
    })).rejects.toThrow(/another fenced runtime scope/i);
    await expect(composed.credentialEgress!.revoke({
      scope,
      fence,
      binding: prepared,
      reason: "failed",
    })).rejects.toThrow(/never attached to provider compute/i);
    await expect(composed.credentialEgress!.release({
      scope: otherScope,
      fence: otherFence,
      binding: prepared,
    })).rejects.toThrow(/another runtime scope/i);
    await composed.credentialEgress!.release({ scope, fence, binding: prepared });
    await expect(composed.credentialEgress!.release({ scope, fence, binding: prepared }))
      .resolves.toBeUndefined();
  });
});
