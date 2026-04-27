import { Client, type ClientOptions } from "./client.js";
import { AgentsResource } from "./resources/agents.js";
import { EnvironmentsResource } from "./resources/environments.js";
import { SessionsResource } from "./resources/sessions.js";

export { OpenMAError } from "./errors.js";
export { parseSSE } from "./sse.js";
export type { ClientOptions } from "./client.js";
export type * from "./types.js";
export type {
  CreateAgentInput,
  UpdateAgentInput,
  ListAgentsOptions,
} from "./resources/agents.js";
export type {
  CreateSessionInput,
  ListSessionsOptions,
  ListEventsOptions,
  ChatOptions,
  ChatCompleteOptions,
  ChatCompleteResult,
  TailOptions,
} from "./resources/sessions.js";
export type { CreateEnvironmentInput } from "./resources/environments.js";

/**
 * Official TypeScript SDK for openma — typed REST + SSE streaming.
 *
 * ```ts
 * import { OpenMA } from "@openma/sdk";
 *
 * const oma = new OpenMA({ apiKey: process.env.OMA_API_KEY! });
 *
 * // Streaming chat — async iterator over typed events
 * for await (const ev of oma.sessions.chat(sessionId, "Hello")) {
 *   if (ev.type === "agent.message_chunk") process.stdout.write(ev.delta);
 * }
 *
 * // Or the high-level helper that returns assembled text + tool history
 * const reply = await oma.sessions.chatComplete(sessionId, "Hello");
 * console.log(reply.text);
 *
 * // Long-lived tail — never closes; replays history on connect
 * for await (const ev of oma.sessions.tail(sessionId)) { ... }
 * ```
 *
 * Runs anywhere `fetch` exists: Node ≥ 20, Bun, Deno, browsers,
 * Cloudflare Workers. Auth is `x-api-key` (or cookie `bearer` when
 * embedded in the Console). Errors throw `OpenMAError` with
 * `{ status, body, raw }` for switching on.
 */
export class OpenMA {
  readonly client: Client;
  readonly agents: AgentsResource;
  readonly sessions: SessionsResource;
  readonly environments: EnvironmentsResource;

  constructor(opts: ClientOptions) {
    this.client = new Client(opts);
    this.agents = new AgentsResource(this.client);
    this.sessions = new SessionsResource(this.client);
    this.environments = new EnvironmentsResource(this.client);
  }
}
