// @ts-nocheck
import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import {
  generateAgentId,
  generateEnvId,
  generateSessionId,
  generateVaultId,
  generateCredentialId,
  generateMemoryStoreId,
  generateMemoryId,
  generateMemoryVersionId,
  generateFileId,
  generateResourceId,
} from "@open-managed-agents/shared";

// ============================================================
// 1. Prefix checks
// ============================================================
describe("ID generation — prefix checks", () => {
  it("generateAgentId starts with 'agent_'", () => {
    const id = generateAgentId();
    expect(id.startsWith("agent-")).toBe(true);
  });

  it("generateSessionId starts with 'sess_'", () => {
    const id = generateSessionId();
    expect(id.startsWith("sess-")).toBe(true);
  });

  it("generateVaultId starts with 'vlt_'", () => {
    const id = generateVaultId();
    expect(id.startsWith("vlt-")).toBe(true);
  });

  it("generateCredentialId starts with 'cred_'", () => {
    const id = generateCredentialId();
    expect(id.startsWith("cred-")).toBe(true);
  });

  it("generateFileId starts with 'file_'", () => {
    const id = generateFileId();
    expect(id.startsWith("file-")).toBe(true);
  });

  it("generateMemoryStoreId starts with 'memstore_'", () => {
    const id = generateMemoryStoreId();
    expect(id.startsWith("memstore-")).toBe(true);
  });

  it("generateMemoryId starts with 'mem_' but not 'memstore_' or 'memver_'", () => {
    const id = generateMemoryId();
    expect(id.startsWith("mem-")).toBe(true);
    expect(id.startsWith("memstore-")).toBe(false);
    expect(id.startsWith("memver-")).toBe(false);
  });

  it("generateMemoryVersionId starts with 'memver_'", () => {
    const id = generateMemoryVersionId();
    expect(id.startsWith("memver-")).toBe(true);
  });

  it("generateEnvId starts with 'env_'", () => {
    const id = generateEnvId();
    expect(id.startsWith("env-")).toBe(true);
  });

  it("generateResourceId starts with 'sesrsc_'", () => {
    const id = generateResourceId();
    expect(id.startsWith("sesrsc-")).toBe(true);
  });
});

// ============================================================
// 2. Uniqueness and format
// ============================================================
describe("ID generation — uniqueness and format", () => {
  it("50 generated IDs from each generator are all unique", () => {
    const generators = [
      generateAgentId,
      generateEnvId,
      generateSessionId,
      generateVaultId,
      generateCredentialId,
      generateMemoryStoreId,
      generateMemoryId,
      generateMemoryVersionId,
      generateFileId,
      generateResourceId,
    ];

    for (const gen of generators) {
      const ids = new Set<string>();
      for (let i = 0; i < 50; i++) {
        ids.add(gen());
      }
      expect(ids.size).toBe(50);
    }
  });

  it("IDs contain only URL-safe characters (alphanumeric + underscore + hyphen)", () => {
    const generators = [
      generateAgentId,
      generateEnvId,
      generateSessionId,
      generateVaultId,
      generateCredentialId,
      generateMemoryStoreId,
      generateMemoryId,
      generateMemoryVersionId,
      generateFileId,
      generateResourceId,
    ];

    const urlSafePattern = /^[a-zA-Z0-9_-]+$/;

    for (const gen of generators) {
      for (let i = 0; i < 20; i++) {
        const id = gen();
        expect(id).toMatch(urlSafePattern);
      }
    }
  });
});
