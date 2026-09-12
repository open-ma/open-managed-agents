import OpenAI from "openai";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { VaultsApplicationService } from "../../managed-agents-application/src/vaults/application";
import type { VaultStore, StoredVault } from "../../vault-store/src/index";
import { buildOpenAIVaultRoutes } from "../src/vaults";

// Only persistence is substituted: the official SDK, HTTP adapter and existing
// workspace-scoped application service execute their real code.
function fixture() {
  const records = new Map<string, StoredVault>();
  const key = (w: string, id: string) => `${w}/${id}`;
  const store: VaultStore = {
    async insert({ workspaceId, vault }) {
      const record = { vault: structuredClone(vault), revision: 1 };
      records.set(key(workspaceId, vault.id), record);
      return structuredClone(record);
    },
    async find({ workspaceId, vaultId }) {
      return structuredClone(records.get(key(workspaceId, vaultId)) ?? null);
    },
    async delete({ workspaceId, vaultId }) {
      return { type: records.delete(key(workspaceId, vaultId)) ? "deleted" : "not_found" };
    },
    async list({ workspaceId, limit, includeArchived, position }) {
      return [...records.entries()].filter(([k]) => k.startsWith(`${workspaceId}/`))
        .map(([, v]) => v)
        .filter(({ vault: v }) => includeArchived || v.archivedAt === null)
        .filter(({ vault: v }) => !position || v.createdAt > position.createdAt || (v.createdAt === position.createdAt && v.id > position.vaultId))
        .sort((a, b) => a.vault.createdAt.localeCompare(b.vault.createdAt) || a.vault.id.localeCompare(b.vault.id))
        .slice(0, limit).map(v => structuredClone(v));
    },
    async replace() { throw new Error("Unexpected replace"); },
    async archive() { throw new Error("Unexpected archive"); },
  };
  let sequence = 0;
  const service = (workspaceId: string) => new VaultsApplicationService({
    workspaceId, store,
    clock: { now: () => new Date("2026-09-11T00:00:00Z") },
    ids: { nextVaultId: () => `vlt_${String(++sequence).padStart(3, "0")}` },
  });
  const ports = { a: service("a"), b: service("b") };
  const app = new Hono().route("/v1/vaults", buildOpenAIVaultRoutes(c => c.req.header("x-workspace") === "b" ? ports.b : ports.a));
  const client = (workspace = "a") => new OpenAI({
    apiKey: "offline-audit", baseURL: "http://openma.test/v1", maxRetries: 0,
    defaultHeaders: { "x-workspace": workspace },
    fetch: async (input, init) => app.fetch(new Request(input, init)),
  });
  return { app, client, ports, records };
}

describe("OpenAI vaults → existing OMA application", () => {
  it("persists a trimmed named vault and roundtrips it through the SDK", async () => {
    const { client, ports } = fixture();
    const api = client().beta.agents.vaults;
    const vault = await api.create({ name: "  production  ", metadata: { team: "platform" } });
    expect(vault).toEqual({ id: "vlt_001", object: "vault", name: "production", metadata: { team: "platform" }, created_at: 1789084800 });
    expect(await api.retrieve(vault.id)).toEqual(vault);
    expect(await ports.a.retrieveVault({ vaultId: vault.id })).toMatchObject({ type: "found", vault: { displayName: "production" } });
    expect(await api.delete(vault.id)).toEqual({ id: vault.id, object: "vault.deleted", deleted: true });
    await expect(api.retrieve(vault.id)).rejects.toBeInstanceOf(OpenAI.NotFoundError);
  });

  it("resolves workspace scope separately for each request", async () => {
    const { client } = fixture();
    const vault = await client("a").beta.agents.vaults.create({ name: "private" });
    await expect(client("b").beta.agents.vaults.retrieve(vault.id)).rejects.toBeInstanceOf(OpenAI.NotFoundError);
    await expect(client("b").beta.agents.vaults.delete(vault.id)).rejects.toBeInstanceOf(OpenAI.NotFoundError);
    expect((await client("b").beta.agents.vaults.list()).data).toEqual([]);
  });

  it("adapts SDK ID pagination and defaults to descending order including archived vaults", async () => {
    const { client, records } = fixture();
    const api = client().beta.agents.vaults;
    for (const name of ["one", "two", "three", "four", "five"]) await api.create({ name });
    records.get("a/vlt_003")!.vault.archivedAt = "2026-09-11T01:00:00Z";
    const ids: string[] = [];
    for await (const v of api.list({ limit: 2 })) ids.push(v.id);
    expect(ids).toEqual(["vlt_005", "vlt_004", "vlt_003", "vlt_002", "vlt_001"]);
    expect((await api.list({ order: "asc", after: "vlt_002", status: "active" })).data.map(v => v.id)).toEqual(["vlt_004", "vlt_005"]);
    expect((await api.list({ status: ["archived"] })).data.map(v => v.id)).toEqual(["vlt_003"]);
    await expect(api.list({ after: "other-workspace" })).rejects.toBeInstanceOf(OpenAI.BadRequestError);
  });

  it("rejects missing beta, invalid metadata and unknown query options before a mutation", async () => {
    const { app, client, records } = fixture();
    const response = await app.request("/v1/vaults", { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"test"}' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error" } });
    await expect(client().beta.agents.vaults.create({ name: "test", metadata: { wrong: 1 } as never })).rejects.toBeInstanceOf(OpenAI.BadRequestError);
    const invalidQuery = await app.request("/v1/vaults?before=123", { headers: { "OpenAI-Beta": "agents=v1" } });
    expect(invalidQuery.status).toBe(400);
    expect(records.size).toBe(0);
  });

  it("traverses OMA pages before applying the OpenAI after ID", async () => {
    const { client, ports } = fixture();
    for (let i = 0; i < 103; i++) await ports.a.createVault({ displayName: `vault ${i}` });
    const page = await client().beta.agents.vaults.list({ order: "asc", after: "vlt_100", limit: 2 });
    expect(page.data.map(v => v.id)).toEqual(["vlt_101", "vlt_102"]);
    expect((await page.getNextPage()).data.map(v => v.id)).toEqual(["vlt_103"]);
  });

  it("reports unsupported optional names without inventing a stored name", async () => {
    const { client, records } = fixture();
    await expect(client().beta.agents.vaults.create()).rejects.toMatchObject({ status: 501, code: "unsupported_feature", param: "name" });
    expect(records.size).toBe(0);
  });

  it("enforces UTF-8 byte limits independently of OMA character limits", async () => {
    const { client, records } = fixture();
    await expect(client().beta.agents.vaults.create({ name: "猫".repeat(86) })).rejects.toBeInstanceOf(OpenAI.BadRequestError);
    await expect(client().beta.agents.vaults.create({ name: "a".repeat(256) })).rejects.toMatchObject({ status: 501, code: "unsupported_feature" });
    expect(records.size).toBe(0);
  });
});
