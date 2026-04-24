// @ts-nocheck
import { describe, it, expect } from "vitest";
import { outboundByHost } from "../../apps/agent/src/outbound";
import type { Env } from "@open-managed-agents/shared";
import type { OutboundSnapshot } from "@open-managed-agents/outbound-snapshots-store";

/**
 * outboundByHost reads through services.outboundSnapshots.get → CONFIG_KV
 * key `outbound:{sessionId}`. The snapshot carries the per-session credential
 * bag in OutboundSnapshot shape — the old per-credential KV layout is gone.
 */
function makeMockEnv(snapshots: Record<string, OutboundSnapshot | string | null>): Env {
  const kv = {
    get: async (key: string) => {
      const v = snapshots[key];
      if (v === undefined || v === null) return null;
      return typeof v === "string" ? v : JSON.stringify(v);
    },
    list: async () => ({ keys: [] }),
    put: async () => {},
    delete: async () => {},
    getWithMetadata: async () => ({ value: null, metadata: null }),
  };
  return {
    CONFIG_KV: kv as unknown as KVNamespace,
    SESSION_DO: {} as any,
    SANDBOX: {} as any,
    API_KEY: "test",
    ANTHROPIC_API_KEY: "test",
  } as Env;
}

function snapshot(opts: {
  vaults: Array<{
    id: string;
    creds: Array<{
      id: string;
      url?: string;
      type?: string;
      token?: string;
      access_token?: string;
      noAuth?: boolean;
    }>;
  }>;
}): OutboundSnapshot {
  return {
    tenant_id: "tnt_test",
    vault_ids: opts.vaults.map((v) => v.id),
    vault_credentials: opts.vaults.map((v) => ({
      vault_id: v.id,
      credentials: v.creds.map((c) => ({
        id: c.id,
        auth: c.noAuth
          ? undefined
          : {
              type: c.type ?? "static_bearer",
              mcp_server_url: c.url,
              token: c.token,
              access_token: c.access_token,
            },
      })),
    })),
  };
}

describe("Outbound credential matching — extended", () => {
  it("multiple vaults in session — checks all vaults for matching credential", async () => {
    const mockEnv = makeMockEnv({
      "outbound:sess_multi": snapshot({
        vaults: [
          { id: "vlt_1", creds: [] },
          {
            id: "vlt_2",
            creds: [{ id: "cred_a", url: "https://target.example.com/mcp", token: "tok_target" }],
          },
        ],
      }),
    });

    const result = await outboundByHost("target.example.com", mockEnv, "sess_multi");
    expect(result).toBe("outbound");
  });

  it("matches first credential across multiple vaults", async () => {
    const mockEnv = makeMockEnv({
      "outbound:sess_first": snapshot({
        vaults: [
          {
            id: "vlt_a",
            creds: [{ id: "cred_1", url: "https://first.example.com/mcp", token: "tok_first" }],
          },
          {
            id: "vlt_b",
            creds: [{ id: "cred_2", url: "https://first.example.com/mcp", token: "tok_second" }],
          },
        ],
      }),
    });

    const result = await outboundByHost("first.example.com", mockEnv, "sess_first");
    expect(result).toBe("outbound");
  });

  it("OAuth credential type (mcp_oauth) with access_token", async () => {
    const mockEnv = makeMockEnv({
      "outbound:sess_oauth": snapshot({
        vaults: [
          {
            id: "vlt_oauth",
            creds: [
              {
                id: "cred_o1",
                type: "mcp_oauth",
                url: "https://oauth.provider.com/api",
                access_token: "oauth_access_tok_123",
              },
            ],
          },
        ],
      }),
    });

    const result = await outboundByHost("oauth.provider.com", mockEnv, "sess_oauth");
    expect(result).toBe("outbound");
  });

  it("URL with port in mcp_server_url — hostname matches without port", async () => {
    // URL.hostname strips port, so "https://mcp.example.com:8080/mcp" has hostname "mcp.example.com"
    const mockEnv = makeMockEnv({
      "outbound:sess_port": snapshot({
        vaults: [
          {
            id: "vlt_port",
            creds: [{ id: "cred_p1", url: "https://mcp.example.com:8080/mcp", token: "tok_port" }],
          },
        ],
      }),
    });

    const result = await outboundByHost("mcp.example.com", mockEnv, "sess_port");
    expect(result).toBe("outbound");
  });

  it("URL with path segments still matches by hostname", async () => {
    const mockEnv = makeMockEnv({
      "outbound:sess_path": snapshot({
        vaults: [
          {
            id: "vlt_path",
            creds: [{ id: "cred_pp", url: "https://deep.host.io/v1/api/mcp/stream", token: "tok_deep" }],
          },
        ],
      }),
    });

    const result = await outboundByHost("deep.host.io", mockEnv, "sess_path");
    expect(result).toBe("outbound");
  });

  it("empty vault_ids array returns null", async () => {
    const mockEnv = makeMockEnv({
      "outbound:sess_empty_vaults": snapshot({ vaults: [] }),
    });

    const result = await outboundByHost("example.com", mockEnv, "sess_empty_vaults");
    expect(result).toBeNull();
  });

  it("missing snapshot returns null", async () => {
    const mockEnv = makeMockEnv({});
    const result = await outboundByHost("example.com", mockEnv, "sess_unknown");
    expect(result).toBeNull();
  });

  it("credential with missing auth field returns null (no crash)", async () => {
    const mockEnv = makeMockEnv({
      "outbound:sess_noauth": snapshot({
        vaults: [{ id: "vlt_noauth", creds: [{ id: "cred_na", noAuth: true }] }],
      }),
    });

    const result = await outboundByHost("example.com", mockEnv, "sess_noauth");
    expect(result).toBeNull();
  });

  it("credential whose host doesn't match returns null", async () => {
    const mockEnv = makeMockEnv({
      "outbound:sess_nomatch": snapshot({
        vaults: [
          {
            id: "vlt_nm",
            creds: [{ id: "cred_x", url: "https://other.example.com/api", token: "tok_x" }],
          },
        ],
      }),
    });

    const result = await outboundByHost("example.com", mockEnv, "sess_nomatch");
    expect(result).toBeNull();
  });

  it("multiple credentials per vault — first matching wins", async () => {
    const mockEnv = makeMockEnv({
      "outbound:sess_multi_cred": snapshot({
        vaults: [
          {
            id: "vlt_mc",
            creds: [
              { id: "cred_1", url: "https://nomatch.example.com/api", token: "tok_no" },
              { id: "cred_2", url: "https://yes.example.com/api", token: "tok_yes" },
              { id: "cred_3", url: "https://yes.example.com/other", token: "tok_also_yes" },
            ],
          },
        ],
      }),
    });

    const result = await outboundByHost("yes.example.com", mockEnv, "sess_multi_cred");
    expect(result).toBe("outbound");
  });

  it("snapshot JSON that is malformed returns null", async () => {
    const mockEnv = makeMockEnv({
      "outbound:sess_bad_json": "{ this is not valid json !!!",
    });

    const result = await outboundByHost("example.com", mockEnv, "sess_bad_json");
    expect(result).toBeNull();
  });

  it("vault with no credentials (empty list) returns null", async () => {
    const mockEnv = makeMockEnv({
      "outbound:sess_empty_creds": snapshot({
        vaults: [{ id: "vlt_empty", creds: [] }],
      }),
    });

    const result = await outboundByHost("example.com", mockEnv, "sess_empty_creds");
    expect(result).toBeNull();
  });
});
