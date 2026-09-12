export interface BuildVercelFunctionOptions {
  entryPoint?: string;
  outputFile?: string;
}

export function buildVercelFunction(
  options?: BuildVercelFunctionOptions,
): Promise<{
  bytes: number;
  sha256: string;
}>;
