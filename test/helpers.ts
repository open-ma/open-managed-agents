// @ts-nocheck
/**
 * Shared test helpers for creating agents, environments, and sessions.
 * Handles the environment build-complete flow required by the new architecture.
 */
import { env } from "cloudflare:workers";

const HEADERS = { "Content-Type": "application/json", "x-api-key": "test-key" };

function api(path: string, init?: RequestInit) {
  return env.default.fetch(new Request(`http://localhost${path}`, init));
}

export async function createReadyEnvironment(name = "test-env") {
  const envRes = await api("/v1/environments", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ name, config: { type: "cloud" } }),
  });
  const environment = (await envRes.json()) as any;

  // Mark environment as ready (simulates build-complete callback)
  // sandbox_worker_name won't match a real binding, but sessions.ts
  // falls back to local SessionDO when env.SESSION_DO is available
  await env.CONFIG_KV.put(
    `env:${environment.id}`,
    JSON.stringify({
      ...environment,
      status: "ready",
      sandbox_worker_name: "test-local",
    })
  );

  return environment;
}

export async function createFullSession(opts?: { agentOverrides?: Record<string, unknown> }) {
  const agentRes = await api("/v1/agents", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      name: "Test Agent",
      model: "claude-sonnet-4-6",
      system: "You are helpful.",
      tools: [{ type: "agent_toolset_20260401" }],
      harness: "test",
      ...opts?.agentOverrides,
    }),
  });
  const agent = (await agentRes.json()) as any;
  const environment = await createReadyEnvironment();
  const sessRes = await api("/v1/sessions", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ agent: agent.id, environment_id: environment.id, title: "Test" }),
  });
  const session = (await sessRes.json()) as any;
  return { agent, environment, session };
}

export function postMessage(sessionId: string, text: string) {
  return api(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      events: [{ type: "user.message", content: [{ type: "text", text }] }],
    }),
  });
}
