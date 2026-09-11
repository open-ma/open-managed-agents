import { beforeEach, describe, expect, it } from "vitest";
import type { FileRecord } from "@open-managed-agents/file-store";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import { SqlFileStore } from "../src/index";

const schema = `
CREATE TABLE managed_files (
  workspace_id text NOT NULL,
  id text NOT NULL,
  document text NOT NULL,
  created_at integer NOT NULL,
  scope_id text,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX idx_managed_files_workspace_created_id
  ON managed_files (workspace_id, created_at, id);
CREATE INDEX idx_managed_files_workspace_scope_created_id
  ON managed_files (workspace_id, scope_id, created_at, id);
`;

function file(id: string, createdAt: string, scopeId?: string): FileRecord {
  return {
    id,
    createdAt,
    filename: `${id}.txt`,
    mimeType: "text/plain",
    sizeBytes: 1,
    downloadable: true,
    ...(scopeId === undefined
      ? {}
      : { scope: { type: "session" as const, id: scopeId } }),
  };
}

describe("SqlFileStore", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(schema);
  });

  it("persists exact session output provenance in the existing file document without another table", async () => {
    const store = new SqlFileStore(client);
    await store.insert({ workspaceId: "workspace_a", file: { ...file("artifact_snapshot", "2026-09-11T01:00:00.000Z", "session_a"), origin: { type: "session_output", sessionId: "session_a", environmentId: "environment_original", turnId: "completed_execution_7", path: "/workspace/outputs/report.txt" } } });
    const recreated = new SqlFileStore(client);
    expect(await recreated.find({ workspaceId: "workspace_a", fileId: "artifact_snapshot" })).toMatchObject({ scope: { type: "session", id: "session_a" }, origin: { type: "session_output", sessionId: "session_a", environmentId: "environment_original", turnId: "completed_execution_7", path: "/workspace/outputs/report.txt" } });
    expect(await recreated.find({ workspaceId: "workspace_b", fileId: "artifact_snapshot" })).toBeNull();
  });

  it("preserves tenant-scoped directional and scope-filtered metadata behavior", async () => {
    const store = new SqlFileStore(client);
    const oldest = file("file_01", "2026-08-26T01:00:00.000Z", "session_01");
    const middle = file("file_02", "2026-08-26T02:00:00.000Z", "session_01");
    const newest = file("file_03", "2026-08-26T03:00:00.000Z");
    for (const value of [oldest, middle, newest]) {
      await store.insert({ workspaceId: "workspace_a", file: value });
    }
    await store.insert({
      workspaceId: "workspace_b",
      file: file("file_01", "2026-08-26T04:00:00.000Z"),
    });

    await expect(store.list({
      workspaceId: "workspace_a",
      limit: 10,
      position: { fileId: newest.id, direction: "after" },
    })).resolves.toEqual([middle, oldest]);
    await expect(store.list({
      workspaceId: "workspace_a",
      limit: 10,
      position: { fileId: oldest.id, direction: "before" },
    })).resolves.toEqual([newest, middle]);
    await expect(store.list({
      workspaceId: "workspace_a",
      limit: 10,
      scopeId: "session_01",
    })).resolves.toEqual([middle, oldest]);
    await expect(store.find({
      workspaceId: "workspace_b",
      fileId: oldest.id,
    })).resolves.toMatchObject({ createdAt: "2026-08-26T04:00:00.000Z" });
  });
});
