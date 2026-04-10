declare namespace Cloudflare {
  interface Env {
    CONFIG_KV: KVNamespace;
    BUILDER_SANDBOX: DurableObjectNamespace;
    SESSION_DO?: DurableObjectNamespace;
    SANDBOX?: DurableObjectNamespace;
    WORKSPACE_BUCKET?: R2Bucket;
    ASSETS?: { fetch: (req: Request) => Promise<Response> };
    API_KEY: string;
    ANTHROPIC_API_KEY: string;
    ANTHROPIC_BASE_URL?: string;
    ANTHROPIC_MODEL?: string;
    TAVILY_API_KEY?: string;
    CLOUDFLARE_API_TOKEN?: string;
    CLOUDFLARE_ACCOUNT_ID?: string;
    GITHUB_TOKEN?: string;
    GITHUB_REPO?: string;
    BUILD_CALLBACK_SECRET?: string;
    RATE_LIMIT_WRITE?: number;
    RATE_LIMIT_READ?: number;
  }

  interface GlobalProps {
    mainModule: typeof import("./src/index");
  }
}
