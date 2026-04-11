// @ts-nocheck
import { describe, it, expect } from "vitest";
import { outboundByHost } from "../../apps/agent/src/outbound";
import type { Env } from "@open-managed-agents/shared";

function makeMockEnv(
  kvData: Record<string, string | null>,
  kvListData?: Record<string, { keys: { name: string }[] }>
): Env {
  return {
    CONFIG_KV: {
      get: async (key: string) => kvData[key] ?? null,
      list: async (opts: { prefix: string }) => {
        if (kvListData && kvListData[opts.prefix]) {
          return kvListData[opts.prefix];
        }
        return { keys: [] };
      },
      put: async () => {},
      delete: async () => {},
      getWithMetadata: async () => ({ value: null, metadata: null }),
    } as unknown as KVNamespace,
    SESSION_DO: {} as any,
    SANDBOX: {} as any,
    API_KEY: "test",
    ANTHROPIC_API_KEY: "test",
  } as Env;
}

describe("Outbound credential matching — extended", () => {
  it("multiple vaults in session — checks all vaults for matching credential", async () => {
    const mockEnv = makeMockEnv(
      {
        "session:sess_multi": JSON.stringify({ vault_ids: ["vlt_1", "vlt_2"] }),
        "cred:vlt_2:cred_a": JSON.stringify({
          auth: {
            type: "static_bearer",
            mcp_server_url: "https://target.example.com/mcp",
            token: "tok_target",
          },
        }),
      },
      {
        "cred:vlt_1:": { keys: [] },
        "cred:vlt_2:": { keys: [{ name: "cred:vlt_2:cred_a" }] },
      }
    );

    const result = await outboundByHost("target.example.com", mockEnv, "sess_multi");
    expect(result).toBe("outbound");
  });

  it("matches first credential across multiple vaults", async () => {
    const mockEnv = makeMockEnv(
      {
        "session:sess_first": JSON.stringify({ vault_ids: ["vlt_a", "vlt_b"] }),
        "cred:vlt_a:cred_1": JSON.stringify({
          auth: {
            type: "static_bearer",
            mcp_server_url: "https://first.example.com/mcp",
            token: "tok_first",
          },
        }),
        "cred:vlt_b:cred_2": JSON.stringify({
          auth: {
            type: "static_bearer",
            mcp_server_url: "https://first.example.com/mcp",
            token: "tok_second",
          },
        }),
      },
      {
        "cred:vlt_a:": { keys: [{ name: "cred:vlt_a:cred_1" }] },
        "cred:vlt_b:": { keys: [{ name: "cred:vlt_b:cred_2" }] },
      }
    );

    // Should match from the first vault (vlt_a) and return "outbound"
    const result = await outboundByHost("first.example.com", mockEnv, "sess_first");
    expect(result).toBe("outbound");
  });

  it("OAuth credential type (mcp_oauth) with access_token", async () => {
    const mockEnv = makeMockEnv(
      {
        "session:sess_oauth": JSON.stringify({ vault_ids: ["vlt_oauth"] }),
        "cred:vlt_oauth:cred_o1": JSON.stringify({
          auth: {
            type: "mcp_oauth",
            mcp_server_url: "https://oauth.provider.com/api",
            access_token: "oauth_access_tok_123",
          },
        }),
      },
      {
        "cred:vlt_oauth:": { keys: [{ name: "cred:vlt_oauth:cred_o1" }] },
      }
    );

    const result = await outboundByHost("oauth.provider.com", mockEnv, "sess_oauth");
    expect(result).toBe("outbound");
  });

  it("URL with port in mcp_server_url — hostname matches without port", async () => {
    // URL.hostname strips port, so "https://mcp.example.com:8080/mcp" has hostname "mcp.example.com"
    const mockEnv = makeMockEnv(
      {
        "session:sess_port": JSON.stringify({ vault_ids: ["vlt_port"] }),
        "cred:vlt_port:cred_p1": JSON.stringify({
          auth: {
            type: "static_bearer",
            mcp_server_url: "https://mcp.example.com:8080/mcp",
            token: "tok_port",
          },
        }),
      },
      {
        "cred:vlt_port:": { keys: [{ name: "cred:vlt_port:cred_p1" }] },
      }
    );

    const result = await outboundByHost("mcp.example.com", mockEnv, "sess_port");
    expect(result).toBe("outbound");
  });

  it("URL with path segments still matches by hostname", async () => {
    const mockEnv = makeMockEnv(
      {
        "session:sess_path": JSON.stringify({ vault_ids: ["vlt_path"] }),
        "cred:vlt_path:cred_pp": JSON.stringify({
          auth: {
            type: "static_bearer",
            mcp_server_url: "https://deep.host.io/v1/api/mcp/stream",
            token: "tok_deep",
          },
        }),
      },
      {
        "cred:vlt_path:": { keys: [{ name: "cred:vlt_path:cred_pp" }] },
      }
    );

    const result = await outboundByHost("deep.host.io", mockEnv, "sess_path");
    expect(result).toBe("outbound");
  });

  it("empty vault_ids array returns null", async () => {
    const mockEnv = makeMockEnv({
      "session:sess_empty_vaults": JSON.stringify({ vault_ids: [] }),
    });

    const result = await outboundByHost("example.com", mockEnv, "sess_empty_vaults");
    expect(result).toBeNull();
  });

  it("vault_ids is undefined/missing returns null", async () => {
    const mockEnv = makeMockEnv({
      "session:sess_no_vids": JSON.stringify({ agent_id: "a1" }),
    });

    const result = await outboundByHost("example.com", mockEnv, "sess_no_vids");
    expect(result).toBeNull();
  });

  it("credential with missing auth field returns null (no crash)", async () => {
    const mockEnv = makeMockEnv(
      {
        "session:sess_noauth": JSON.stringify({ vault_ids: ["vlt_noauth"] }),
        "cred:vlt_noauth:cred_na": JSON.stringify({
          name: "some credential without auth",
        }),
      },
      {
        "cred:vlt_noauth:": { keys: [{ name: "cred:vlt_noauth:cred_na" }] },
      }
    );

    const result = await outboundByHost("example.com", mockEnv, "sess_noauth");
    expect(result).toBeNull();
  });

  it("session data without vault_ids property returns null", async () => {
    const mockEnv = makeMockEnv({
      "session:sess_novault_prop": JSON.stringify({
        agent_id: "agent_xyz",
        status: "idle",
      }),
    });

    const result = await outboundByHost("example.com", mockEnv, "sess_novault_prop");
    expect(result).toBeNull();
  });

  it("multiple credentials per vault — first match wins", async () => {
    const mockEnv = makeMockEnv(
      {
        "session:sess_multi_cred": JSON.stringify({ vault_ids: ["vlt_mc"] }),
        "cred:vlt_mc:cred_1": JSON.stringify({
          auth: {
            type: "static_bearer",
            mcp_server_url: "https://nomatch.example.com/api",
            token: "tok_no",
          },
        }),
        "cred:vlt_mc:cred_2": JSON.stringify({
          auth: {
            type: "static_bearer",
            mcp_server_url: "https://yes.example.com/api",
            token: "tok_yes",
          },
        }),
        "cred:vlt_mc:cred_3": JSON.stringify({
          auth: {
            type: "static_bearer",
            mcp_server_url: "https://yes.example.com/other",
            token: "tok_also_yes",
          },
        }),
      },
      {
        "cred:vlt_mc:": {
          keys: [
            { name: "cred:vlt_mc:cred_1" },
            { name: "cred:vlt_mc:cred_2" },
            { name: "cred:vlt_mc:cred_3" },
          ],
        },
      }
    );

    // Should match cred_2 (first credential whose hostname is yes.example.com)
    const result = await outboundByHost("yes.example.com", mockEnv, "sess_multi_cred");
    expect(result).toBe("outbound");
  });

  it("session JSON that is malformed returns null", async () => {
    const mockEnv = makeMockEnv({
      "session:sess_bad_json": "{ this is not valid json !!!",
    });

    const result = await outboundByHost("example.com", mockEnv, "sess_bad_json");
    expect(result).toBeNull();
  });

  it("vault with no credentials (empty list) returns null", async () => {
    const mockEnv = makeMockEnv(
      {
        "session:sess_empty_creds": JSON.stringify({ vault_ids: ["vlt_empty"] }),
      },
      {
        "cred:vlt_empty:": { keys: [] },
      }
    );

    const result = await outboundByHost("example.com", mockEnv, "sess_empty_creds");
    expect(result).toBeNull();
  });
});
