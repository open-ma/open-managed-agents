export type VercelNetworkMatcher =
  | { exact: string }
  | { startsWith: string }
  | { regex: string };

export interface VercelNetworkRule {
  match?: {
    path?: VercelNetworkMatcher;
    method?: string[];
    queryString?: Array<{ key?: VercelNetworkMatcher; value?: VercelNetworkMatcher }>;
    headers?: Array<{ key?: VercelNetworkMatcher; value?: VercelNetworkMatcher }>;
  };
  transform?: Array<{ headers?: Record<string, string> }>;
  forwardURL?: string;
}

export type VercelNetworkPolicy =
  | "allow-all"
  | "deny-all"
  | {
      allow?: string[] | Record<string, VercelNetworkRule[]>;
      subnets?: { allow?: string[]; deny?: string[] };
    };

export interface VercelCommandFinishedPort {
  readonly exitCode: number;
  stdout(options?: { signal?: AbortSignal }): Promise<string>;
  stderr(options?: { signal?: AbortSignal }): Promise<string>;
}

export interface VercelCommandPort {
  wait(options?: { signal?: AbortSignal }): Promise<{ exitCode: number }>;
  kill(
    signal?: "SIGTERM" | "SIGKILL",
    options?: { abortSignal?: AbortSignal },
  ): Promise<void>;
}

export interface VercelRunCommandInput {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  detached?: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface VercelSandboxSdkPort {
  readonly name: string;
  readonly status: string;
  readonly persistent: boolean;
  readonly tags: Record<string, string> | undefined;
  readonly currentSnapshotId: string | undefined;
  readonly expiresAt: Date | undefined;
  extendTimeout(durationMs: number, options?: { signal?: AbortSignal }): Promise<void>;
  runCommand(input: VercelRunCommandInput & { detached: true }): Promise<VercelCommandPort>;
  runCommand(input: VercelRunCommandInput): Promise<VercelCommandFinishedPort>;
  mkDir(path: string, options?: { signal?: AbortSignal }): Promise<void>;
  readFileToBuffer(
    file: { path: string; cwd?: string },
    options?: { signal?: AbortSignal },
  ): Promise<Uint8Array | null>;
  writeFiles(
    files: Array<{ path: string; content: string | Uint8Array; mode?: number }>,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  stop(options?: { signal?: AbortSignal }): Promise<{
    snapshot?: { id?: string };
  }>;
  updateNetworkPolicy(
    policy: VercelNetworkPolicy,
    options?: { signal?: AbortSignal },
  ): Promise<VercelNetworkPolicy>;
  delete(options?: { deleteOrphanSnapshots?: boolean; signal?: AbortSignal }): Promise<void>;
}

export interface VercelCredentials {
  token: string;
  teamId: string;
  projectId: string;
}

export interface VercelCreateOptions {
  image?: string;
  source?:
    | { type: "git"; url: string; depth?: number; revision?: string }
    | {
        type: "git";
        url: string;
        username: string;
        password: string;
        depth?: number;
        revision?: string;
      }
    | { type: "tarball"; url: string }
    | { type: "snapshot"; snapshotId: string };
  ports?: number[];
  timeout?: number;
  resources?: { vcpus: number };
  region?: string;
  failoverRegions?: string[];
  snapshotExpiration?: number;
  keepLastSnapshots?: { count: number; expiration?: number; deleteEvicted?: boolean };
}

export interface VercelGetOrCreateOptions extends VercelCreateOptions {
  name: string;
  persistent: true;
  resume: true;
  tags: Record<string, string>;
  networkPolicy: VercelNetworkPolicy;
  signal?: AbortSignal;
}

export interface VercelSdkPort {
  getOrCreate(options: VercelGetOrCreateOptions): Promise<VercelSandboxSdkPort>;
  get(options: {
    name: string;
    resume?: boolean;
    signal?: AbortSignal;
  }): Promise<VercelSandboxSdkPort>;
}

function isStopped(status: string): boolean {
  return ["stopped", "failed", "aborted"].includes(status.toLowerCase());
}

export async function renewVercelSandboxLease(input: {
  sandbox: VercelSandboxSdkPort;
  ttlMs: number;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<void> {
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
    throw new Error("Vercel sandbox lease ttlMs must be a positive finite number");
  }
  input.signal?.throwIfAborted();
  if (isStopped(input.sandbox.status)) {
    throw new Error("Vercel sandbox is no longer available");
  }
  const now = input.now ?? Date.now;
  const expiresAtMs = input.sandbox.expiresAt?.getTime();
  if (expiresAtMs !== undefined && expiresAtMs <= now()) {
    throw new Error("Vercel sandbox is no longer available");
  }
  const remainingMs = expiresAtMs === undefined ? 0 : expiresAtMs - now();
  const extensionMs = Math.ceil(input.ttlMs - remainingMs);
  if (extensionMs <= 0) return;
  if (input.signal === undefined) {
    await input.sandbox.extendTimeout(extensionMs);
  } else {
    await input.sandbox.extendTimeout(extensionMs, { signal: input.signal });
  }
  input.signal?.throwIfAborted();
}
