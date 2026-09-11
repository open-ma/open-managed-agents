import { describe, expect, it } from "vitest";
import { createInMemoryFileService } from "./test-fakes";

describe("FileService session cleanup", () => {
  it("only removes session-scoped rows from the requested tenant", async () => {
    const { service } = createInMemoryFileService();

    await service.create({
      id: "file_a",
      tenantId: "tenant_a",
      sessionId: "session_same",
      filename: "a.txt",
      mediaType: "text/plain",
      sizeBytes: 1,
      r2Key: "t/tenant_a/file_a",
    });
    await service.create({
      id: "file_b",
      tenantId: "tenant_b",
      sessionId: "session_same",
      filename: "b.txt",
      mediaType: "text/plain",
      sizeBytes: 1,
      r2Key: "t/tenant_b/file_b",
    });

    const deleted = await service.deleteBySession({
      tenantId: "tenant_a",
      sessionId: "session_same",
    });

    expect(deleted.map((file) => file.id)).toEqual(["file_a"]);
    await expect(
      service.get({ tenantId: "tenant_b", fileId: "file_b" }),
    ).resolves.toMatchObject({ id: "file_b", tenant_id: "tenant_b" });
  });
});
