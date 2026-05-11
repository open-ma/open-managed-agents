// Abstract ports CAP depends on. Same DIP pattern as
// open-managed-agents/packages/vaults-store/src/ports.ts.
//
// These are tiny on purpose: every method takes plain data and returns
// plain data. No fetch, no Date, no console — those are what the consumer
// supplies via the impl.

// ─── Resolver: the credential lookup port ──────────────────────────────────

export interface Resolver {
  /**
   * Return the live credential for (principal, cli_id, hostname), or null if
   * no credential is configured.
   *
   * The resolver owns lifecycle: cache, OAuth refresh, lease renewal,
   * rotation. CAP treats the returned token as opaque and trusts it until
   * the next call to `invalidate(...)`.
   */
  resolve(input: ResolveInput): Promise<ResolvedToken | null>;

  /**
   * Mark the credential at (principal, cli_id, hostname) as known-bad.
   * L4 calls this after observing an upstream 401 with a recently-resolved
   * token. The next `resolve(...)` should return a freshly-fetched token,
   * not the cached one.
   */
  invalidate(input: ResolveInput): Promise<void>;

  /**
   * Persist `token` as the live credential at (principal, cli_id,
   * hostname). Called by L4 after a successful OAuth Device Flow
   * acquisition (see `src/oauth.ts`) — the resolver writes the
   * access_token (and refresh_token in extras) back to its backing vault.
   *
   * Subsequent calls to `resolve(...)` with the same input must return the
   * stored token until the resolver decides it has expired or been
   * invalidated.
   */
  store(input: ResolveInput, token: ResolvedToken): Promise<void>;
}

export interface ResolveInput {
  /**
   * Opaque to CAP. The resolver decides what it means: tenant id, session
   * id, user id, CI job id, or a structured tuple serialized to a string.
   */
  readonly principal: string;

  /** Matches CapSpec.cli_id of the spec L2 selected for this request. */
  readonly cli_id: string;

  /**
   * Hostname extracted from the request URL (header_inject) or determined
   * by the spec (metadata_ep, exec_helper). Lowercase, no port.
   */
  readonly hostname: string;
}

export interface ResolvedToken {
  /**
   * Primary credential value substituted into the spec's header template
   * (header_inject) or used as the main secret in the metadata / exec
   * response. For AWS Container Credentials this is the `SecretAccessKey`;
   * for everything else it's the bearer / api-key.
   */
  readonly token: string;

  /**
   * Unix epoch in milliseconds. Required for metadata_ep (the response
   * envelope must include an expiration; the SDK will refetch before then).
   * Optional for header_inject and exec_helper — those refresh by 401
   * rather than by clock.
   */
  readonly expires_at?: number;

  /**
   * Mode-specific extra fields. Keys are protocol-defined:
   *
   *   aws_container_credentials_v1:
   *     - "access_key_id"    (required)
   *     - "session_token"    (optional, set when token is STS-derived)
   *
   *   gcp_metadata_v1: none — `token` is the OAuth access_token
   *
   *   header / kubectl / docker / git: ignored
   *
   * Modes look up only the keys they expect; unknown keys are silently
   * ignored. This keeps the Resolver port stable as new modes get added.
   */
  readonly extras?: Readonly<Record<string, string>>;
}

// ─── Clock — explicit, no hidden Date.now() in the lib ────────────────────

export interface Clock {
  nowMs(): number;
}

// ─── Logger — optional. Defaults to silent. ───────────────────────────────

export interface Logger {
  warn(msg: string, ctx?: unknown): void;
}
