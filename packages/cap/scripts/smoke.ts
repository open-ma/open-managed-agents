// CAP smoke test — exercises the public API end-to-end without any
// test-only imports. Proves that `import {…} from "cap"` (resolved here
// via ./src/index.ts because we're in-tree) works as documented.
//
// Run with: node --import tsx scripts/smoke.ts  OR  pnpm dlx tsx scripts/smoke.ts
//
// (For TS-aware Node 24+ with --experimental-strip-types, also runs as
//  `node --experimental-strip-types scripts/smoke.ts` from the repo root.)

import {
  builtinSpecs,
  createSpecRegistry,
  handleHttp,
  handleExec,
  buildDeviceInitiateRequest,
  parseDeviceInitiateResponse,
  type Resolver,
  type ResolveInput,
  type ResolvedToken,
  type Clock,
} from "../src/index";

// ─── A bare-bones in-memory Resolver consumers would write themselves ────

class StaticResolver implements Resolver {
  private creds = new Map<string, ResolvedToken>();
  set(input: ResolveInput, token: ResolvedToken): void {
    this.creds.set(`${input.principal}|${input.cli_id}|${input.hostname}`, token);
  }
  async resolve(input: ResolveInput): Promise<ResolvedToken | null> {
    return this.creds.get(`${input.principal}|${input.cli_id}|${input.hostname}`) ?? null;
  }
  async invalidate(input: ResolveInput): Promise<void> {
    this.creds.delete(`${input.principal}|${input.cli_id}|${input.hostname}`);
  }
  async store(input: ResolveInput, token: ResolvedToken): Promise<void> {
    this.set(input, token);
  }
}

const realClock: Clock = { nowMs: () => Date.now() };

async function main(): Promise<void> {
  const registry = createSpecRegistry(builtinSpecs);
  const resolver = new StaticResolver();
  resolver.set(
    { principal: "alice", cli_id: "gh", hostname: "api.github.com" },
    { token: "ghp_smoke_test_token" },
  );

  const deps = { resolver, registry, clock: realClock };

  // ─── Scenario 1: gh API call gets Bearer-injected ────────────────────────
  const ghResult = await handleHttp(
    {
      url: "https://api.github.com/user",
      method: "GET",
      headers: {},
      body: null,
    },
    { principal: "alice" },
    deps,
  );

  assert(ghResult.kind === "forward", `gh: expected forward, got ${ghResult.kind}`);
  if (ghResult.kind === "forward") {
    assert(
      ghResult.req.headers["Authorization"] === "Bearer ghp_smoke_test_token",
      `gh: wrong Authorization header — got ${ghResult.req.headers["Authorization"]}`,
    );
    console.log("✓ gh: Authorization injected correctly");
  }

  // ─── Scenario 2: unknown host passes through ────────────────────────────
  const unknownResult = await handleHttp(
    { url: "https://example.com", method: "GET", headers: {}, body: null },
    { principal: "alice" },
    deps,
  );
  assert(unknownResult.kind === "passthrough", "unknown host should passthrough");
  console.log("✓ unknown host: passthrough");

  // ─── Scenario 3: docker credential helper ────────────────────────────────
  resolver.set(
    { principal: "alice", cli_id: "docker", hostname: "index.docker.io" },
    { token: "dckr_pat_xyz" },
  );
  const dockerResult = await handleExec(
    "docker",
    { principal: "alice", hostname: "index.docker.io" },
    { args: ["get"], stdin: "https://index.docker.io/v1/\n" },
    deps,
  );
  assert(dockerResult.kind === "stdout", "docker: expected stdout");
  if (dockerResult.kind === "stdout") {
    const body = JSON.parse(dockerResult.text);
    assert(body.Secret === "dckr_pat_xyz", "docker: wrong Secret");
    console.log("✓ docker: get returned credential JSON");
  }

  // ─── Scenario 4: gh OAuth device-flow initiate request shape ────────────
  const ghSpec = registry.byCliId("gh")!;
  const initReq = buildDeviceInitiateRequest(ghSpec);
  assert(initReq.url === "https://github.com/login/device/code", "gh oauth initiate url");
  assert(initReq.headers["Accept"] === "application/json", "gh oauth Accept header");
  console.log("✓ gh oauth: device flow initiate request shaped correctly");

  // Round-trip a synthetic initiate response.
  const fakeInitRes = {
    status: 200,
    headers: {},
    body: JSON.stringify({
      device_code: "dc_test",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    }),
  };
  const state = parseDeviceInitiateResponse(ghSpec, fakeInitRes, realClock);
  assert(state.user_code === "ABCD-1234", "gh oauth: parsed user_code");
  console.log("✓ gh oauth: device flow initiate response parsed correctly");

  console.log(`\nAll smoke checks passed (${builtinSpecs.length} builtin CLIs registered).`);
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("smoke test threw:", err);
  process.exit(1);
});
