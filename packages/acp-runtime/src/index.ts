export type {
  AgentSpec,
  ChildHandle,
  Spawner,
  AcpSession,
  AcpRuntime,
  RestartPolicy,
  SessionOptions,
} from "./types.js";

// Renamed `AcpRuntimeImpl` → `AcpRuntime` would collide with the same-named
// interface above. Keep the impl class postfix-named; callers do
// `new AcpRuntimeImpl(spawner)`. Slightly ugly, unambiguous.
export { AcpRuntimeImpl } from "./runtime.js";
export { AcpSessionImpl } from "./session.js";

export { KNOWN_ACP_AGENTS, detect, detectAll, type KnownAgentEntry } from "./registry.js";
