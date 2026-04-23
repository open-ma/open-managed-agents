/** Typed errors so HTTP handlers can map to status codes without leaking internals. */

export class CredentialNotFoundError extends Error {
  readonly code = "credential_not_found";
  constructor(message = "Credential not found") {
    super(message);
  }
}

/** Per-vault credential count exceeded MAX_CREDENTIALS_PER_VAULT. */
export class CredentialMaxExceededError extends Error {
  readonly code = "credential_max_exceeded";
  constructor(public readonly limit: number) {
    super(`Maximum ${limit} credentials per vault`);
  }
}

/** Adapter-level partial UNIQUE violation surfaced as domain error. */
export class CredentialDuplicateMcpUrlError extends Error {
  readonly code = "credential_duplicate_mcp_url";
  constructor(message = "A credential with this mcp_server_url already exists") {
    super(message);
  }
}

/** mcp_server_url is treated as immutable post-create — see vaults.ts:208. */
export class CredentialImmutableFieldError extends Error {
  readonly code = "credential_immutable_field";
  constructor(public readonly field: string) {
    super(`${field} is immutable`);
  }
}
