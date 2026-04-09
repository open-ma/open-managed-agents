export interface Env {
  CONFIG_KV: KVNamespace;
  SESSION_DO: DurableObjectNamespace;
  SANDBOX: DurableObjectNamespace;
  WORKSPACE_BUCKET?: R2Bucket;
  API_KEY: string;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_BASE_URL?: string;
  TAVILY_API_KEY?: string;
  RATE_LIMIT_WRITE?: number;
  RATE_LIMIT_READ?: number;
}
