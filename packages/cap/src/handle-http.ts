import { ResolverError } from "./errors";
import { applyHeader } from "./modes/header";
import { applyAwsMetadata } from "./modes/metadata-aws";
import { applyGcpMetadata } from "./modes/metadata-gcp";
import type { Clock, Logger, ResolveInput, ResolvedToken, Resolver } from "./ports";
import type { SpecRegistry } from "./registry";
import type { CapSpec, HttpHandleResult, HttpReqLike } from "./types";

export interface HandleHttpDeps {
  readonly resolver: Resolver;
  readonly registry: SpecRegistry;
  readonly clock: Clock;
  readonly logger?: Logger;
}

export interface HandleHttpContext {
  /** Opaque to CAP. Forwarded to the resolver as ResolveInput.principal. */
  readonly principal: string;
}

/**
 * Entry point for HTTPS-MITM-style L4 adapters (CF Sandbox outbound,
 * mockttp daemon, k8s sidecar). Given an outbound HTTP request, returns
 * one of:
 *   - "forward"    — caller dispatches the rewritten request upstream
 *   - "respond"    — caller serves the synthesized response locally
 *   - "passthrough" — caller forwards the original request unchanged
 *
 * URL parsing failures and exec_helper specs reachable by hostname both
 * resolve to passthrough — the L4 adapter shouldn't get worse behaviour
 * because of a malformed URL or a misconfigured spec.
 */
export async function handleHttp(
  req: HttpReqLike,
  ctx: HandleHttpContext,
  deps: HandleHttpDeps,
): Promise<HttpHandleResult> {
  const hostname = parseHostname(req.url);
  if (hostname === null) return { kind: "passthrough" };

  const spec = deps.registry.byHostname(hostname);
  if (spec === null) return { kind: "passthrough" };

  // exec_helper CLIs don't communicate over HTTP — the helper is invoked
  // by the CLI as a subprocess. If a request actually reaches us claiming
  // to be for one, treat it as suspicious and passthrough; the L4 adapter
  // can decide whether to log.
  if (spec.inject_mode === "exec_helper") {
    deps.logger?.warn(
      `handleHttp: exec_helper spec matched a hostname — refusing to inject`,
      { cli_id: spec.cli_id, hostname },
    );
    return { kind: "passthrough" };
  }

  const resolveInput: ResolveInput = {
    principal: ctx.principal,
    cli_id: spec.cli_id,
    hostname,
  };

  const token = await safeResolve(deps.resolver, resolveInput);

  return dispatch(spec, token, req, deps.clock);
}

function dispatch(
  spec: CapSpec,
  token: ResolvedToken | null,
  req: HttpReqLike,
  clock: Clock,
): HttpHandleResult {
  if (spec.inject_mode === "header") {
    return applyHeader(spec, token, req);
  }
  // metadata_ep — exec_helper is filtered out at the call site.
  switch (spec.metadata!.protocol) {
    case "aws_container_credentials_v1":
      return applyAwsMetadata(spec, token, req, clock);
    case "gcp_metadata_v1":
      return applyGcpMetadata(spec, token, req, clock);
  }
}

async function safeResolve(
  resolver: Resolver,
  input: ResolveInput,
): Promise<ResolvedToken | null> {
  try {
    return await resolver.resolve(input);
  } catch (err) {
    throw new ResolverError(err);
  }
}

/**
 * Returns the lowercase hostname from the URL, or null if the URL is
 * malformed. Strips port via the URL constructor's `hostname` getter.
 */
function parseHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
