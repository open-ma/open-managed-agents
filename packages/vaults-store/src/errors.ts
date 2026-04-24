/** Typed errors so HTTP handlers can map to status codes without leaking internals. */

export class VaultNotFoundError extends Error {
  readonly code = "vault_not_found";
  constructor(message = "Vault not found") {
    super(message);
  }
}
