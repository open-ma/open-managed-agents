import { ResolverError, UnknownCliError } from "./errors";
import { applyDockerExec } from "./modes/exec-docker";
import { applyGitExec } from "./modes/exec-git";
import { applyKubectlExec } from "./modes/exec-kubectl";
import type { Clock, Logger, ResolveInput, ResolvedToken, Resolver } from "./ports";
import type { SpecRegistry } from "./registry";
import type { ExecHandleResult, ExecHelperInput } from "./types";

export interface HandleExecDeps {
  readonly resolver: Resolver;
  readonly registry: SpecRegistry;
  readonly clock: Clock;
  readonly logger?: Logger;
}

export interface HandleExecContext {
  readonly principal: string;
  /**
   * Hostname the resolver should look up. Optional because some exec_helper
   * CLIs (kubectl in some configs, docker without an explicit registry)
   * don't expose the hostname to the helper. Falls back to the cli_id when
   * absent, so the resolver still receives a stable, principal-scoped key.
   */
  readonly hostname?: string;
}

/**
 * Entry point for credential-helper L4 adapters. The L4 adapter is a small
 * binary the CLI invokes (kubectl exec credential plugin,
 * docker-credential-<name>, git-credential-<name>); it forwards stdin /
 * env / argv to handleExec and writes the result back to stdout.
 *
 * Throws:
 *   - UnknownCliError when cli_id is missing from the registry, or maps to
 *     a non-exec_helper spec (calling handleExec on header_inject /
 *     metadata_ep is a programmer error).
 *   - ResolverError when the consumer's resolver throws.
 */
export async function handleExec(
  cli_id: string,
  ctx: HandleExecContext,
  input: ExecHelperInput,
  deps: HandleExecDeps,
): Promise<ExecHandleResult> {
  const spec = deps.registry.byCliId(cli_id);
  if (spec === null || spec.inject_mode !== "exec_helper" || !spec.exec) {
    throw new UnknownCliError(cli_id);
  }

  const resolveInput: ResolveInput = {
    principal: ctx.principal,
    cli_id,
    hostname: ctx.hostname ?? cli_id,
  };

  const token = await safeResolve(deps.resolver, resolveInput);

  switch (spec.exec.protocol) {
    case "kubectl_exec_credential_v1":
      return applyKubectlExec(cli_id, token, input, deps.clock);
    case "docker_credential_helper":
      return applyDockerExec(cli_id, token, input);
    case "git_credential_helper":
      return applyGitExec(cli_id, token, input);
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
