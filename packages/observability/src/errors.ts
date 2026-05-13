// Error normalization — kept structurally identical to packages/shared so
// downstream log aggregators see one schema.

export interface NormalizedErr {
  message: string;
  name: string;
  stack?: string;
  cause?: string;
}

export function normalizeErr(err: unknown): NormalizedErr | string {
  if (err instanceof Error) {
    const out: NormalizedErr = {
      message: err.message || "(empty)",
      name: err.name,
    };
    if (err.stack) {
      out.stack = err.stack.split("\n").slice(0, 6).join("\n");
    }
    if ("cause" in err && err.cause !== undefined) {
      out.cause = String(err.cause);
    }
    return out;
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function errFields(err: unknown): { error_name: string; error_message: string } {
  if (err instanceof Error) {
    return {
      error_name: err.name || "Error",
      error_message: err.message || "(empty)",
    };
  }
  if (typeof err === "string") {
    return { error_name: "string", error_message: err };
  }
  return { error_name: typeof err, error_message: String(err) };
}
