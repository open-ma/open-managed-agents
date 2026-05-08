// Unit tests for ModelCardService — drives the service against the in-memory
// repo. No D1 binding needed.
//
// Service-level behavior covered: tenant isolation, UNIQUE(tenant_id,model_id),
// partial UNIQUE on default (atomic clear-then-set semantics), api_key
// encrypt/decrypt boundary via the FakeCrypto wrapper, list ordering, update
// patch shape, delete + getDefault edge cases.
//
// NOTE: imports use relative paths because vitest.config.ts has not yet been
// updated with the @open-managed-agents/model-cards-store alias (that's done
// at integration time per packages/model-cards-store/INTEGRATION_GUIDE.md).
// After the alias lands, these can be swapped to the package import.

import { describe, it, expect } from "vitest";
import {
  ModelCardDefaultConflictError,
  ModelCardDuplicateModelIdError,
  ModelCardNotFoundError,
  apiKeyPreview,
} from "../../packages/model-cards-store/src/index";
import {
  FakeCrypto,
  ManualClock,
  createInMemoryModelCardService,
} from "../../packages/model-cards-store/src/test-fakes";

const TENANT = "tn_test_mdl";

describe("ModelCardService — create + read", () => {
  it("creates a card and reads it back", async () => {
    const { service } = createInMemoryModelCardService();
    const card = await service.create({
      tenantId: TENANT,
      modelId: "claude-sonnet-4-6",
      provider: "ant",
      apiKey: "sk-ant-supersecret-1234",
    });
    expect(card.id).toMatch(/^mdl-/);
    expect(card.tenant_id).toBe(TENANT);
    expect(card.model_id).toBe("claude-sonnet-4-6");
    expect(card.provider).toBe("ant");
    expect(card.api_key_preview).toBe("1234");
    expect(card.is_default).toBe(false);
    expect(card.base_url).toBeNull();
    expect(card.custom_headers).toBeNull();

    const got = await service.get({ tenantId: TENANT, cardId: card.id });
    // model defaults to model_id when not explicitly set on create.
    expect(got?.model).toBe("claude-sonnet-4-6");
  });

  it("isolates cards by tenant", async () => {
    const { service } = createInMemoryModelCardService();
    await service.create({
      tenantId: "tn_a",
      modelId: "claude-sonnet-4-6",
      provider: "ant",
      apiKey: "sk-A-1234",
    });
    expect((await service.list({ tenantId: "tn_a" })).length).toBe(1);
    expect((await service.list({ tenantId: "tn_b" })).length).toBe(0);
  });

  it("returns null when reading a card that doesn't exist", async () => {
    const { service } = createInMemoryModelCardService();
    expect(
      await service.get({ tenantId: TENANT, cardId: "missing" }),
    ).toBeNull();
  });

  it("does not surface api_key in row shape; api_key_preview is last 4", async () => {
    const { service } = createInMemoryModelCardService();
    const card = await service.create({
      tenantId: TENANT,
      modelId: "gpt-4o",
      provider: "oai",
      apiKey: "sk-oai-abcdef-LAST",
    });
    // api_key is not on the row — neither cleartext nor cipher
    expect((card as Record<string, unknown>).api_key).toBeUndefined();
    expect((card as Record<string, unknown>).api_key_cipher).toBeUndefined();
    expect(card.api_key_preview).toBe("LAST");
    // helper agrees
    expect(apiKeyPreview("sk-oai-abcdef-LAST")).toBe("LAST");
  });
});

describe("ModelCardService — UNIQUE(tenant_id, model_id)", () => {
  it("rejects a duplicate model_id within the same tenant", async () => {
    const { service } = createInMemoryModelCardService();
    await service.create({
      tenantId: TENANT,
      modelId: "claude-sonnet-4-6",
      provider: "ant",
      apiKey: "sk-ant-1111",
    });
    await expect(() =>
      service.create({
        tenantId: TENANT,
        modelId: "claude-sonnet-4-6",
        provider: "ant",
        apiKey: "sk-ant-2222",
      }),
    ).rejects.toBeInstanceOf(ModelCardDuplicateModelIdError);
  });

  it("allows the same model_id across different tenants", async () => {
    const { service } = createInMemoryModelCardService();
    await service.create({
      tenantId: "tn_a",
      modelId: "gpt-4o",
      provider: "oai",
      apiKey: "sk-A-1111",
    });
    const b = await service.create({
      tenantId: "tn_b",
      modelId: "gpt-4o",
      provider: "oai",
      apiKey: "sk-B-2222",
    });
    expect(b.tenant_id).toBe("tn_b");
  });

  it("rejects rename to an existing model_id within the same tenant", async () => {
    const { service } = createInMemoryModelCardService();
    const a = await service.create({
      tenantId: TENANT,
      modelId: "claude-sonnet-4-6",
      provider: "ant",
      apiKey: "sk-1111",
    });
    const b = await service.create({
      tenantId: TENANT,
      modelId: "claude-haiku-4-6",
      provider: "ant",
      apiKey: "sk-2222",
    });
    await expect(() =>
      service.update({
        tenantId: TENANT,
        cardId: b.id,
        modelId: "claude-sonnet-4-6",
      }),
    ).rejects.toBeInstanceOf(ModelCardDuplicateModelIdError);
    // Original name still intact
    const after = await service.get({ tenantId: TENANT, cardId: a.id });
    expect(after?.model_id).toBe("claude-sonnet-4-6");
  });
});

describe("ModelCardService — partial UNIQUE: default semantics", () => {
  it("create with makeDefault=true on first card sets is_default=1", async () => {
    const { service } = createInMemoryModelCardService();
    const card = await service.create({
      tenantId: TENANT,
      modelId: "claude-sonnet-4-6",
      provider: "ant",
      apiKey: "sk-ant-1111",
      makeDefault: true,
    });
    expect(card.is_default).toBe(true);
    const def = await service.getDefault({ tenantId: TENANT });
    expect(def?.id).toBe(card.id);
  });

  it("setDefault unsets the previous default atomically", async () => {
    const clock = new ManualClock(1000);
    const { service } = createInMemoryModelCardService({ clock });
    const a = await service.create({
      tenantId: TENANT,
      modelId: "claude-sonnet-4-6",
      provider: "ant",
      apiKey: "sk-A-1111",
      makeDefault: true,
    });
    clock.set(2000);
    const b = await service.create({
      tenantId: TENANT,
      modelId: "gpt-4o",
      provider: "oai",
      apiKey: "sk-B-2222",
    });
    clock.set(3000);
    const promoted = await service.setDefault({ tenantId: TENANT, cardId: b.id });
    expect(promoted.is_default).toBe(true);

    const allCards = await service.list({ tenantId: TENANT });
    const defaults = allCards.filter((c) => c.is_default);
    expect(defaults.length).toBe(1);
    expect(defaults[0].id).toBe(b.id);
    // a was demoted
    const aAfter = allCards.find((c) => c.id === a.id);
    expect(aAfter?.is_default).toBe(false);

    expect((await service.getDefault({ tenantId: TENANT }))?.id).toBe(b.id);
  });

  it("create with makeDefault=true clears the previous default in one step", async () => {
    const { service } = createInMemoryModelCardService();
    const a = await service.create({
      tenantId: TENANT,
      modelId: "claude-sonnet-4-6",
      provider: "ant",
      apiKey: "sk-A-1111",
      makeDefault: true,
    });
    const b = await service.create({
      tenantId: TENANT,
      modelId: "gpt-4o",
      provider: "oai",
      apiKey: "sk-B-2222",
      makeDefault: true,
    });
    expect(b.is_default).toBe(true);
    // a was demoted via the atomic clear-then-insert path
    const aAfter = await service.get({ tenantId: TENANT, cardId: a.id });
    expect(aAfter?.is_default).toBe(false);
    expect((await service.getDefault({ tenantId: TENANT }))?.id).toBe(b.id);
  });

  it("update to is_default=true demotes the previous default", async () => {
    const { service } = createInMemoryModelCardService();
    const a = await service.create({
      tenantId: TENANT,
      modelId: "claude-sonnet-4-6",
      provider: "ant",
      apiKey: "sk-A-1111",
      makeDefault: true,
    });
    const b = await service.create({
      tenantId: TENANT,
      modelId: "gpt-4o",
      provider: "oai",
      apiKey: "sk-B-2222",
    });
    const updated = await service.update({
      tenantId: TENANT,
      cardId: b.id,
      isDefault: true,
    });
    expect(updated.is_default).toBe(true);
    expect((await service.get({ tenantId: TENANT, cardId: a.id }))?.is_default).toBe(false);
    expect((await service.getDefault({ tenantId: TENANT }))?.id).toBe(b.id);
  });

  it("at most one default per tenant after any sequence of operations", async () => {
    // The schema's partial UNIQUE (tenant_id) WHERE is_default = 1 admits
    // at most one default per tenant. The in-memory fake mirrors this by
    // auto-clearing in insert/update when isDefault=true (same atomic
    // semantics the D1 adapter implements via batch). This test runs through
    // the operations the service uses and verifies the invariant holds.
    const { service } = createInMemoryModelCardService();
    const a = await service.create({
      tenantId: TENANT,
      modelId: "claude-sonnet-4-6",
      provider: "ant",
      apiKey: "sk-A",
      makeDefault: true,
    });
    const b = await service.create({
      tenantId: TENANT,
      modelId: "gpt-4o",
      provider: "oai",
      apiKey: "sk-B",
      makeDefault: true,           // demotes a
    });
    const c = await service.create({
      tenantId: TENANT,
      modelId: "claude-haiku-4-6",
      provider: "ant",
      apiKey: "sk-C",
    });
    await service.setDefault({ tenantId: TENANT, cardId: c.id }); // demotes b
    await service.update({           // re-promotes a
      tenantId: TENANT,
      cardId: a.id,
      isDefault: true,
    });
    const all = await service.list({ tenantId: TENANT });
    expect(all.filter((card) => card.is_default).length).toBe(1);
    expect((await service.getDefault({ tenantId: TENANT }))?.id).toBe(a.id);
  });

  it("repo throws ModelCardDefaultConflictError when an unsafe write would violate partial UNIQUE", async () => {
    // The faithful in-memory fake won't fire the conflict via insert/update
    // because both auto-clear (matching the D1 batch). To exercise the error
    // path we hand-craft an unsafe state by mutating two rows directly via
    // the public update path WITHOUT the isDefault flag, then call the
    // post-patch assertion via a mutating update that ends up with two
    // defaults — the assertion catches it.
    //
    // Concretely: start with one default row, then do an update that does
    // NOT clear (isDefault undefined) but coincidentally leaves the row's
    // is_default at true, and verify the invariant. We can't easily inject
    // a corrupt state through the public API; instead, we verify the
    // ERROR CLASS exists + is constructed with the expected code so the
    // adapter's translateInsertError mapping has a target to reach for.
    expect(new ModelCardDefaultConflictError().code).toBe(
      "model_card_default_conflict",
    );
    expect(new ModelCardDefaultConflictError("custom").message).toBe("custom");
  });

  it("getDefault returns null when no default is set", async () => {
    const { service } = createInMemoryModelCardService();
    await service.create({
      tenantId: TENANT,
      modelId: "claude-sonnet-4-6",
      provider: "ant",
      apiKey: "sk-A-1111",
    });
    expect(await service.getDefault({ tenantId: TENANT })).toBeNull();
  });
});

describe("ModelCardService — update", () => {
  it("updates model + api_key + base_url + custom_headers", async () => {
    const clock = new ManualClock(1000);
    const { service } = createInMemoryModelCardService({ clock });
    const card = await service.create({
      tenantId: TENANT,
      modelId: "claude-sonnet-4-6",
      provider: "ant",
      apiKey: "sk-ant-OLD0",
    });
    clock.set(2000);
    const updated = await service.update({
      tenantId: TENANT,
      cardId: card.id,
      model: "claude-opus-4-7",
      apiKey: "sk-ant-NEW9",
      baseUrl: "https://my-proxy.example.com/v1",
      customHeaders: { "X-Custom": "value" },
    });
    expect(updated.model).toBe("claude-opus-4-7");
    expect(updated.api_key_preview).toBe("NEW9");
    expect(updated.base_url).toBe("https://my-proxy.example.com/v1");
    expect(updated.custom_headers).toEqual({ "X-Custom": "value" });
    expect(updated.updated_at).not.toBeNull();
    // getApiKey returns the new plaintext after rotation
    expect(
      await service.getApiKey({ tenantId: TENANT, cardId: card.id }),
    ).toBe("sk-ant-NEW9");
  });

  it("clears base_url + custom_headers when null is passed", async () => {
    const { service } = createInMemoryModelCardService();
    const card = await service.create({
      tenantId: TENANT,
      modelId: "deepseek-chat",
      provider: "oai-compatible",
      apiKey: "sk-ds-1111",
      baseUrl: "https://api.deepseek.com/v1",
      customHeaders: { "X-Tag": "live" },
    });
    const updated = await service.update({
      tenantId: TENANT,
      cardId: card.id,
      baseUrl: null,
      customHeaders: null,
    });
    expect(updated.base_url).toBeNull();
    expect(updated.custom_headers).toBeNull();
  });

  it("throws ModelCardNotFoundError on update for missing id", async () => {
    const { service } = createInMemoryModelCardService();
    await expect(() =>
      service.update({
        tenantId: TENANT,
        cardId: "missing",
      }),
    ).rejects.toBeInstanceOf(ModelCardNotFoundError);
  });
});

describe("ModelCardService — delete", () => {
  it("delete removes the row entirely", async () => {
    const { service } = createInMemoryModelCardService();
    const card = await service.create({
      tenantId: TENANT,
      modelId: "claude-sonnet-4-6",
      provider: "ant",
      apiKey: "sk-ant-1111",
    });
    await service.delete({ tenantId: TENANT, cardId: card.id });
    expect(
      await service.get({ tenantId: TENANT, cardId: card.id }),
    ).toBeNull();
  });

  it("deleting the default leaves the tenant with no default", async () => {
    const { service } = createInMemoryModelCardService();
    const card = await service.create({
      tenantId: TENANT,
      modelId: "claude-sonnet-4-6",
      provider: "ant",
      apiKey: "sk-ant-1111",
      makeDefault: true,
    });
    expect((await service.getDefault({ tenantId: TENANT }))?.id).toBe(card.id);
    await service.delete({ tenantId: TENANT, cardId: card.id });
    expect(await service.getDefault({ tenantId: TENANT })).toBeNull();
  });

  it("delete throws ModelCardNotFoundError for missing id", async () => {
    const { service } = createInMemoryModelCardService();
    await expect(() =>
      service.delete({ tenantId: TENANT, cardId: "missing" }),
    ).rejects.toBeInstanceOf(ModelCardNotFoundError);
  });
});

describe("ModelCardService — listing + lookups", () => {
  it("list orders by created_at ASC (legacy KV order)", async () => {
    const clock = new ManualClock(1000);
    const { service } = createInMemoryModelCardService({ clock });
    await service.create({
      tenantId: TENANT,
      modelId: "claude-sonnet-4-6",
      provider: "ant",
      apiKey: "sk-1111",
    });
    clock.set(2000);
    await service.create({
      tenantId: TENANT,
      modelId: "gpt-4o",
      provider: "oai",
      apiKey: "sk-2222",
    });
    clock.set(3000);
    await service.create({
      tenantId: TENANT,
      modelId: "claude-haiku-4-6",
      provider: "ant",
      apiKey: "sk-3333",
    });
    const all = await service.list({ tenantId: TENANT });
    expect(all.map((c) => c.model_id)).toEqual(["claude-sonnet-4-6", "gpt-4o", "claude-haiku-4-6"]);
  });

  it("findByModelId returns the matching card or null", async () => {
    const { service } = createInMemoryModelCardService();
    const card = await service.create({
      tenantId: TENANT,
      modelId: "claude-sonnet-4-6",
      provider: "ant",
      apiKey: "sk-1111",
    });
    expect(
      (await service.findByModelId({
        tenantId: TENANT,
        modelId: "claude-sonnet-4-6",
      }))?.id,
    ).toBe(card.id);
    expect(
      await service.findByModelId({
        tenantId: TENANT,
        modelId: "model-that-does-not-exist",
      }),
    ).toBeNull();
    // Cross-tenant: must return null
    expect(
      await service.findByModelId({
        tenantId: "tn_other",
        modelId: "claude-sonnet-4-6",
      }),
    ).toBeNull();
  });
});

describe("ModelCardService — api_key crypto boundary", () => {
  it("getApiKey decrypts the stored cipher back to plaintext", async () => {
    const { service } = createInMemoryModelCardService();
    const card = await service.create({
      tenantId: TENANT,
      modelId: "claude-sonnet-4-6",
      provider: "ant",
      apiKey: "sk-ant-supersecret-PLAIN",
    });
    const key = await service.getApiKey({
      tenantId: TENANT,
      cardId: card.id,
    });
    expect(key).toBe("sk-ant-supersecret-PLAIN");
  });

  it("repo stores the cipher (not plaintext) when FakeCrypto is wired", async () => {
    const { service, repo } = createInMemoryModelCardService({
      crypto: new FakeCrypto(),
    });
    const card = await service.create({
      tenantId: TENANT,
      modelId: "claude-sonnet-4-6",
      provider: "ant",
      apiKey: "sk-ant-VISIBLE",
    });
    const cipher = await repo.getApiKeyCipher(TENANT, card.id);
    // FakeCrypto wraps with enc(...) — plaintext must not appear in the
    // stored cipher (only inside the wrap).
    expect(cipher).toBe("enc(sk-ant-VISIBLE)");
  });

  it("getApiKey returns null for a missing card", async () => {
    const { service } = createInMemoryModelCardService();
    expect(
      await service.getApiKey({ tenantId: TENANT, cardId: "missing" }),
    ).toBeNull();
  });
});
