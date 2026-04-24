/** Typed errors so HTTP handlers can map to status codes without leaking internals. */

export class FileNotFoundError extends Error {
  readonly code = "file_not_found";
  constructor(message = "File not found") {
    super(message);
  }
}
