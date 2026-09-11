import {
  createCloudflareManagedEnvironmentWorker as createCoreEnvironmentWorker,
  createCloudflareManagedRuntime as createCoreRuntime,
  createCloudflareManagedRuntimeDriver as createCoreDriver,
  createCloudflareManagedRuntimeHost as createCoreHost,
  type CloudflareManagedEnvironmentWorkerOptions as CoreEnvironmentWorkerOptions,
  type CloudflareManagedRuntimeDriverOptions as CoreDriverOptions,
  type CloudflareManagedRuntimeHostOptions as CoreHostOptions,
  type CloudflareManagedRuntimeOptions as CoreRuntimeOptions,
} from "@open-managed-agents/managed-runtime-cloudflare";
import type { Env } from "@open-managed-agents/shared";

import { CloudflareSandbox } from "./sandbox";

export interface CloudflareManagedRuntimeOptions
  extends Omit<CoreRuntimeOptions, "createSandbox"> {
  createSandbox?: CoreRuntimeOptions["createSandbox"];
}

export interface CloudflareManagedRuntimeHostOptions
  extends Omit<CoreHostOptions, "createSandbox"> {
  createSandbox?: CoreRuntimeOptions["createSandbox"];
}

export interface CloudflareManagedRuntimeDriverOptions
  extends Omit<CoreDriverOptions, "createSandbox"> {
  createSandbox?: CoreRuntimeOptions["createSandbox"];
}

export interface CloudflareManagedEnvironmentWorkerOptions
  extends Omit<CoreEnvironmentWorkerOptions, "runtime"> {
  runtime: CloudflareManagedRuntimeHostOptions;
}

function withSdkSandbox<Options extends CloudflareManagedRuntimeOptions>(
  options: Options,
): Options & Pick<CoreRuntimeOptions, "createSandbox"> {
  return {
    ...options,
    createSandbox: options.createSandbox
      ?? ((runtimeEnv: Env, runtimeId: string) => new CloudflareSandbox(runtimeEnv, runtimeId)),
  };
}

/** Cloudflare application convenience wrapper. Provider lifecycle and Port
 * composition live in the isolated managed-runtime-cloudflare package; this
 * shell supplies only its SDK-backed Sandbox implementation. */
export function createCloudflareManagedRuntime(
  env: Env,
  options: CloudflareManagedRuntimeOptions = {},
) {
  return createCoreRuntime(env, withSdkSandbox(options));
}

export function createCloudflareManagedRuntimeDriver(
  env: Env,
  options: CloudflareManagedRuntimeDriverOptions = {},
) {
  return createCoreDriver(env, withSdkSandbox(options));
}

export function createCloudflareManagedRuntimeHost(
  env: Env,
  options: CloudflareManagedRuntimeHostOptions,
) {
  return createCoreHost(env, withSdkSandbox(options));
}

export function createCloudflareManagedEnvironmentWorker(
  env: Env,
  options: CloudflareManagedEnvironmentWorkerOptions,
) {
  return createCoreEnvironmentWorker(env, {
    ...options,
    runtime: withSdkSandbox(options.runtime),
  });
}
