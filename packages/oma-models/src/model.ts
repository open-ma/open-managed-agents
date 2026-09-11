/** Provider model metadata returned by the OMA discovery extension. */
export interface OmaProviderModel {
  id: string;
  name: string;
  /** Pi provider id, for example `anthropic`, `openai`, or `deepseek`. */
  provider?: string;
  /** Pi protocol adapter selected for the model. */
  api?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  context_window?: number;
  max_tokens?: number;
}
