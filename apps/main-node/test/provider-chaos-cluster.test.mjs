import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChaosPlan,
  buildClusterEnv,
  createMockLlmServer,
  parseProviderConfig,
  redactEnvironment,
} from "../../../scripts/provider-chaos-cluster.mjs";

test("provider config accepts only explicitly supported chaos providers", () => {
  assert.equal(parseProviderConfig({ OMA_CHAOS_PROVIDER: "LiTeBoX" }).provider, "litebox");
  assert.throws(
    () => parseProviderConfig({ OMA_CHAOS_PROVIDER: "subprocess" }),
    /daytona, litebox, boxrun/,
  );
});

test("provider config fails closed when a remote provider is not configured", () => {
  assert.throws(
    () => parseProviderConfig({ OMA_CHAOS_PROVIDER: "daytona" }),
    /DAYTONA_API_KEY/,
  );
  assert.throws(
    () => parseProviderConfig({ OMA_CHAOS_PROVIDER: "boxrun" }),
    /BOXRUN_URL/,
  );
});

test("cluster env isolates persistence and always points model traffic at the fixture", () => {
  const result = buildClusterEnv(
    { ANTHROPIC_API_KEY: "secret", DAYTONA_API_KEY: "daytona-secret" },
    {
      root: "/tmp/openma-chaos-123",
      port: 9876,
      llmBaseUrl: "http://127.0.0.1:4321",
      provider: "daytona",
    },
  );

  assert.equal(result.PORT, "9876");
  assert.equal(result.AUTH_DISABLED, "1");
  assert.equal(result.SANDBOX_PROVIDER, "daytona");
  assert.equal(result.ANTHROPIC_BASE_URL, "http://127.0.0.1:4321");
  assert.equal(result.DATABASE_PATH, "/tmp/openma-chaos-123/oma.db");
  assert.equal(result.SANDBOX_WORKDIR, "/tmp/openma-chaos-123/sandboxes");
  assert.equal(result.DAYTONA_API_KEY, "daytona-secret");
  assert.equal(redactEnvironment(result).DAYTONA_API_KEY, "<redacted>");
  assert.equal(redactEnvironment(result).ANTHROPIC_API_KEY, "<redacted>");
});

test("chaos plan covers crash recovery and provider-specific optional faults", () => {
  const plan = buildChaosPlan("boxrun", { providerKill: true });
  assert.deepEqual(
    plan.map((step) => step.id),
    ["healthy-turn", "crash-in-flight", "recovered-turn", "provider-kill"],
  );
  assert.equal(plan[1].fault, "main-process-kill");
  assert.equal(plan[3].optional, true);
});

test("local Anthropic fixture serves JSON, SSE, and one-shot faults", async () => {
  const fixture = await createMockLlmServer();
  try {
    const json = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-chaos-local", stream: false }),
    });
    assert.equal(json.status, 200);
    assert.equal((await json.json()).content[0].text, "CHAOS_OK");

    const sse = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-chaos-local", stream: true }),
    });
    assert.equal(sse.status, 200);
    const streamText = await sse.text();
    assert.match(streamText, /event: message_start/);
    assert.match(streamText, /event: content_block_delta/);
    assert.match(streamText, /CHAOS_OK/);

    fixture.setFault({ status: 529 });
    const fault = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-chaos-local" }),
    });
    assert.equal(fault.status, 529);
    assert.equal(fixture.state.requests, 3);
  } finally {
    await fixture.close();
  }
});

test("fixture can force a real sandbox tool round trip", async () => {
  const fixture = await createMockLlmServer({ toolRoundTrip: true });
  try {
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-chaos-local", stream: false, messages: [{ role: "user", content: "run it" }] }),
    });
    const first = await response.json();
    assert.equal(first.stop_reason, "tool_use");
    assert.equal(first.content[0].name, "bash");
    assert.equal(first.content[0].input.command, "printf CHAOS_SANDBOX_OK");

    const followUp = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-chaos-local",
        messages: [
          { role: "user", content: "run it" },
          { role: "assistant", content: first.content },
          { role: "tool", content: [{ type: "tool_result", tool_use_id: "toolu_chaos", content: "CHAOS_SANDBOX_OK" }] },
        ],
      }),
    });
    const second = await followUp.json();
    assert.equal(second.stop_reason, "end_turn");
    assert.equal(second.content[0].text, "CHAOS_OK");
  } finally {
    await fixture.close();
  }
});
