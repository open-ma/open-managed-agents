export function withNetworkCause(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error));

  const cause = error.cause;
  if (!(cause instanceof Error)) return error;

  const code = "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
  return new Error(`${error.message} (${code ?? cause.message})`, { cause: error });
}
