import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { VaultsApplicationPort, VaultView } from "@open-managed-agents/managed-agents-application/ports/vaults";

export type VaultPortSource = VaultsApplicationPort | ((context: Context) => VaultsApplicationPort);

const metadataSchema = z.record(z.string(), z.string());
const createSchema = z.strictObject({ name: z.string().optional(), metadata: metadataSchema.nullable().optional() });
const querySchema = z.strictObject({
  after: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  status: z.array(z.enum(["active", "archived"])).min(1).optional(),
});
const vaultSchema = z.strictObject({
  id: z.string().min(1), object: z.literal("vault"), name: z.string().nullable(),
  created_at: z.number().int().nonnegative(), metadata: metadataSchema,
});

function wire(vault: VaultView) {
  return vaultSchema.parse({
    id: vault.id, object: "vault", name: vault.displayName,
    created_at: Math.floor(Date.parse(vault.createdAt) / 1000), metadata: vault.metadata,
  });
}

function failure(c: Context, status: 400 | 404 | 500 | 501, message: string, param: string | null = null) {
  return c.json({ error: {
    message, type: status >= 500 ? "server_error" : "invalid_request_error",
    code: status === 501 ? "unsupported_feature" : status === 404 ? "resource_not_found" : null, param,
  } }, status);
}

/** Relative to /v1/vaults. Authentication remains owned by the host composition.
 * This bridge uses existing application ports, including workspace resolution.
 * Listing currently scans application pages to translate opaque OMA cursors to
 * OpenAI ID cursors; replace this with an application keyset query before scale.
 */
export function buildOpenAIVaultRoutes(source: VaultPortSource): Hono {
  const app = new Hono();
  const port = (c: Context) => typeof source === "function" ? source(c) : source;
  app.use("*", async (c, next) => {
    if (!(c.req.header("OpenAI-Beta") ?? "").split(",").some(v => v.trim() === "agents=v1")) {
      return failure(c, 400, "OpenAI-Beta: agents=v1 is required", "OpenAI-Beta");
    }
    await next();
  });
  app.onError(() => new Response(JSON.stringify({ error: {
    message: "The vault application returned an invalid result", type: "server_error", code: null, param: null,
  } }), { status: 500, headers: { "content-type": "application/json" } }));

  app.post("/", async c => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return failure(c, 400, "Request body must be valid JSON"); }
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return failure(c, 400, "Invalid vault create request", parsed.error.issues[0]?.path.join(".") ?? null);
    if (parsed.data.name === undefined) return failure(c, 501, "Unnamed vaults require nullable names in the OMA application", "name");
    const name = parsed.data.name.trim();
    const bytes = new TextEncoder().encode(name).byteLength;
    if (bytes < 1 || bytes > 256) return failure(c, 400, "Vault name must contain 1 to 256 UTF-8 bytes after trimming", "name");
    if (name.length > 255 || /\p{Cc}/u.test(name)) return failure(c, 501, "This valid name cannot be represented by the current OMA vault name contract", "name");
    const result = await port(c).createVault({ displayName: name, metadata: parsed.data.metadata ?? {} });
    if (result.type === "invalid_request") return failure(c, 400, result.message);
    return c.json(wire(result.vault));
  });

  app.get("/", async c => {
    const url = new URL(c.req.url);
    const allowed = new Set(["after", "limit", "order", "status", "status[]"]);
    for (const key of url.searchParams.keys()) {
      if (!allowed.has(key)) return failure(c, 400, "Unknown list parameter", key);
      if (key !== "status" && key !== "status[]" && url.searchParams.getAll(key).length > 1) return failure(c, 400, "Duplicate list parameter", key);
    }
    const statuses = [...url.searchParams.getAll("status"), ...url.searchParams.getAll("status[]")];
    const query = querySchema.safeParse({
      ...Object.fromEntries(["after", "limit", "order"].flatMap(key => url.searchParams.has(key) ? [[key, url.searchParams.get(key)]] : [])),
      ...(statuses.length > 0 && { status: statuses }),
    });
    if (!query.success) return failure(c, 400, "Invalid vault list query", query.error.issues[0]?.path.join(".") ?? null);
    const application = port(c);
    const vaults: VaultView[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await application.listVaults({ pageSize: 100, includeArchived: true, ...(cursor && { cursor }) });
      if (result.type === "invalid_request") return failure(c, 400, result.message);
      vaults.push(...result.page.vaults);
      cursor = result.page.nextCursor ?? undefined;
      if (cursor !== undefined) {
        if (seen.has(cursor)) return failure(c, 500, "The vault application returned a repeated cursor");
        seen.add(cursor);
      }
    } while (cursor !== undefined);
    const direction = query.data.order === "asc" ? 1 : -1;
    vaults.sort((a, b) => direction * (a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
    const anchor = query.data.after === undefined ? -1 : vaults.findIndex(v => v.id === query.data.after);
    if (query.data.after !== undefined && anchor === -1) return failure(c, 400, "The after cursor was not found in this workspace", "after");
    const selected = vaults.slice(anchor + 1).filter(v => !query.data.status || query.data.status.includes(v.archivedAt === null ? "active" : "archived"));
    const limit = query.data.limit ?? 20;
    const data = selected.slice(0, limit).map(wire);
    return c.json({ object: "list", data, has_more: selected.length > limit, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
  });

  app.get("/:vaultId", async c => {
    const result = await port(c).retrieveVault({ vaultId: c.req.param("vaultId") });
    return result.type === "not_found" ? failure(c, 404, "Vault not found") : c.json(wire(result.vault));
  });
  app.delete("/:vaultId", async c => {
    const result = await port(c).deleteVault({ vaultId: c.req.param("vaultId") });
    if (result.type === "not_found") return failure(c, 404, "Vault not found");
    if (result.vaultId !== c.req.param("vaultId")) return failure(c, 500, "The vault application returned a mismatched deletion result");
    return c.json({ id: result.vaultId, object: "vault.deleted", deleted: true });
  });
  return app;
}
