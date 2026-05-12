// CAP — CLI Auth Protocol. Public API.
//
// L1 Spec — declarative manifest of how each CLI authenticates.
// L2 Enforcement — pure functions that turn (spec, token, request) into
//   the right wire output for that CLI's protocol.
//
// Consumers implement the `Resolver` port (L3) to plug in their token
// store, and write a thin L4 adapter that wraps handleHttp / handleExec
// in their environment (HTTPS proxy, exec-helper binary, sidecar).
//
// Test consumers should also import from "cap/test-fakes" for FakeResolver
// + ManualClock helpers.

// Types
export type {
  CapSpec,
  HeaderInjectSpec,
  MetadataEpSpec,
  MetadataProtocol,
  ExecHelperSpec,
  ExecProtocol,
  BootstrapSpec,
  EndpointBindingSpec,
  OAuthSpec,
  OAuthDeviceFlowSpec,
  InjectMode,
  HttpReqLike,
  HttpResLike,
  HttpHandleResult,
  ExecHelperInput,
  ExecHandleResult,
} from "./types";

// Ports
export type {
  Resolver,
  ResolveInput,
  ResolvedToken,
  Clock,
  Logger,
} from "./ports";

// Errors
export {
  CapError,
  UnknownCliError,
  MalformedHelperInputError,
  ResolverError,
} from "./errors";

// Registry
export type { SpecRegistry } from "./registry";
export { createSpecRegistry } from "./registry";

// Hostname matching (exposed for L4s that want to reuse the validator)
export { matchesHostname, validateHostnamePattern } from "./hostname-match";

// Built-in CLI specs
export { builtinSpecs } from "./builtin";
export {
  awsSpec,
  doctlSpec,
  dockerSpec,
  flySpec,
  gcloudSpec,
  ghSpec,
  gitSpec,
  glabSpec,
  kubectlSpec,
  npmSpec,
  vercelSpec,
} from "./builtin";

// L2 entrypoints
export type {
  HandleHttpDeps,
  HandleHttpContext,
} from "./handle-http";
export { handleHttp } from "./handle-http";

export type {
  HandleExecDeps,
  HandleExecContext,
} from "./handle-exec";
export { handleExec } from "./handle-exec";

// OAuth Device Authorization Grant builders/parsers
export type {
  DeviceFlowState,
  DevicePollResult,
} from "./oauth";
export {
  buildDeviceInitiateRequest,
  parseDeviceInitiateResponse,
  buildDevicePollRequest,
  parseDevicePollResponse,
} from "./oauth";
