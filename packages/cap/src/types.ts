// CAP — CLI Auth Protocol
//
// Public domain types: declarative manifest of how each CLI authenticates,
// plus shared HTTP/exec shapes that L2 entrypoints consume and produce.
//
// All fields are runtime-agnostic plain data — no Node, no Cloudflare, no
// fetch. L4 adapters serialize to/from their environment's actual request
// types (Workers Request, mockttp CompletedRequest, libcurl, etc).

// ─── Inject mode ───────────────────────────────────────────────────────────

export type InjectMode = "header" | "metadata_ep" | "exec_helper";

// ─── Per-CLI spec ──────────────────────────────────────────────────────────

export interface CapSpec {
  /** Stable id, e.g. "gh" | "aws" | "kubectl". Used by Resolver and L4. */
  readonly cli_id: string;

  /** Human-readable description shown in vault UIs / docs. */
  readonly description: string;

  /**
   * Hostnames this CLI talks to. Either exact (`api.github.com`) or single-
   * level wildcard prefix (`*.amazonaws.com`). Exact match wins over
   * wildcard during lookup. Other glob shapes are rejected by registry.
   */
  readonly endpoints: readonly string[];

  readonly inject_mode: InjectMode;

  /** Required when inject_mode === "header". */
  readonly header?: HeaderInjectSpec;

  /** Required when inject_mode === "metadata_ep". */
  readonly metadata?: MetadataEpSpec;

  /** Required when inject_mode === "exec_helper". */
  readonly exec?: ExecHelperSpec;

  /**
   * Static scaffolding the L4 adapter writes once per sandbox / env so the
   * CLI doesn't refuse to dial out. NOT a credential — value is a sentinel
   * (e.g. "__cap_managed__"). Real token resolution happens at request
   * time.
   */
  readonly bootstrap?: BootstrapSpec;

  /**
   * For metadata_ep CLIs: tells the SDK where our metadata server lives.
   * The L4 adapter substitutes `${cap_host}` / `${cap_port}` and writes the
   * resulting env var alongside `bootstrap.env`.
   */
  readonly endpoint_binding?: EndpointBindingSpec;

  /**
   * OAuth Device Authorization Grant (RFC 8628) configuration. Present
   * only for CLIs whose upstream supports a "go to URL, enter code,
   * confirm" flow (gh, glab, gcloud at time of writing). Drives the
   * acquisition path: L4 calls the L2 OAuth builders/parsers, runs the
   * dance, and on success calls `Resolver.store(...)` to persist the
   * acquired token back to the vault.
   */
  readonly oauth?: OAuthSpec;
}

// ─── Header injection ──────────────────────────────────────────────────────

export interface HeaderInjectSpec {
  /**
   * Headers stripped from the incoming request before injection.
   * Case-insensitive. Always include the auth header you're about to set,
   * plus any aliases (e.g. `["authorization", "x-api-key"]`) so a leaking
   * sandbox can't smuggle a stolen token past us.
   */
  readonly strip: readonly string[];

  /**
   * Header to set after stripping. `value` is a template — `${token}` is
   * substituted with the resolved credential. No other interpolation
   * variables are supported.
   */
  readonly set: { readonly name: string; readonly value: string };
}

// ─── Metadata-endpoint emulation ───────────────────────────────────────────

export type MetadataProtocol =
  | "aws_container_credentials_v1"
  | "gcp_metadata_v1";

export interface MetadataEpSpec {
  readonly protocol: MetadataProtocol;

  /** Path the CLI hits, e.g. `/computeMetadata/v1/instance/service-accounts/default/token`. */
  readonly path?: string;

  /**
   * Request-side validation: the CLI must send these headers with these
   * values, or L2 returns 401 without consulting the resolver. Sentinel
   * `"match_bootstrap_token"` means "compare against the value of the same-
   * name env var in `bootstrap.env`" (used by AWS Container Credentials,
   * where the SDK forwards $AWS_CONTAINER_AUTHORIZATION_TOKEN as the
   * Authorization header). All other strings are literal-equality checks.
   */
  readonly required_request_headers?: Readonly<Record<string, string>>;
}

// ─── Exec credential helper ────────────────────────────────────────────────

export type ExecProtocol =
  | "kubectl_exec_credential_v1"
  | "docker_credential_helper"
  | "git_credential_helper";

export interface ExecHelperSpec {
  readonly protocol: ExecProtocol;
}

// ─── Bootstrap (L4 writes once) ────────────────────────────────────────────

export interface BootstrapSpec {
  /**
   * Env vars to set in the CLI's process env. Values are sentinels — never
   * actual credentials.
   */
  readonly env?: Readonly<Record<string, string>>;

  /**
   * Files to write into the CLI's home dir. `path` is relative to $HOME.
   * Used for CLIs that won't dial out without a config file present
   * (`~/.aws/credentials`, `~/.kube/config`).
   */
  readonly files?: ReadonlyArray<{ readonly path: string; readonly content: string }>;
}

// ─── Endpoint binding (where our metadata server is) ──────────────────────

export interface EndpointBindingSpec {
  /** Env var the CLI / SDK reads, e.g. "AWS_CONTAINER_CREDENTIALS_FULL_URI". */
  readonly env_var: string;

  /**
   * Template the L4 adapter renders. Recognised tokens: `${cap_host}`,
   * `${cap_port}`, `${path}` (= MetadataEpSpec.path). Plain-string
   * substitution; no escaping.
   */
  readonly value_template: string;
}

// ─── OAuth Device Authorization Grant (RFC 8628) ──────────────────────────

export interface OAuthSpec {
  /**
   * Device flow (RFC 8628) — the only OAuth flow CAP currently supports.
   * Designed for CLI / sandbox / TV-style environments where opening a
   * browser callback isn't possible. The user is shown a short user_code
   * and a verification URL; they visit it on a separate device, enter the
   * code, and confirm. The CLI polls the token endpoint until success.
   */
  readonly device_flow: OAuthDeviceFlowSpec;
}

export interface OAuthDeviceFlowSpec {
  /**
   * The upstream's device-authorization endpoint
   * (e.g. https://github.com/login/device/code).
   */
  readonly initiate_url: string;

  /**
   * The upstream's token endpoint
   * (e.g. https://github.com/login/oauth/access_token).
   */
  readonly token_url: string;

  /**
   * The CAP-registered public OAuth client_id for this CLI. Public on
   * purpose — the device flow's security comes from the user's explicit
   * confirmation, not from a client secret.
   */
  readonly client_id: string;

  /** OAuth scopes to request. Empty array means "default scopes". */
  readonly scopes: readonly string[];

  /**
   * Headers to add to BOTH the initiate and poll requests. Useful for
   * upstreams that default to non-JSON responses unless asked
   * (e.g. GitHub returns form-urlencoded unless given Accept:
   * application/json).
   */
  readonly request_headers?: Readonly<Record<string, string>>;
}

// ─── Shared HTTP shapes (used by handleHttp) ──────────────────────────────

export interface HttpReqLike {
  readonly url: string;
  readonly method: string;
  /**
   * Header keys are stored as the caller provided them (mixed case is
   * possible). All matching is done case-insensitively by L2.
   */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ArrayBuffer | null;
}

export interface HttpResLike {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

// ─── handleHttp result ─────────────────────────────────────────────────────

export type HttpHandleResult =
  | {
      /** Send `req` upstream after L2's rewrite. */
      readonly kind: "forward";
      readonly req: HttpReqLike;
    }
  | {
      /** Synthesize a local response (metadata_ep). Don't dial upstream. */
      readonly kind: "respond";
      readonly res: HttpResLike;
    }
  | {
      /** No spec match. Caller forwards the original request unchanged. */
      readonly kind: "passthrough";
    };

// ─── handleExec input/output ───────────────────────────────────────────────

export interface ExecHelperInput {
  /** Raw stdin the CLI piped to the helper binary. */
  readonly stdin?: string;
  /** Process env the helper was invoked with. */
  readonly env?: Readonly<Record<string, string>>;
  /** CLI-supplied positional argv after the helper binary name. */
  readonly args?: readonly string[];
}

export type ExecHandleResult =
  | {
      /** Helper succeeded. `text` is what to write to stdout verbatim. */
      readonly kind: "stdout";
      readonly text: string;
      readonly exit: 0;
    }
  | {
      /** Helper failed. `message` goes to stderr; process exits with `exit`. */
      readonly kind: "error";
      readonly message: string;
      readonly exit: number;
    };
