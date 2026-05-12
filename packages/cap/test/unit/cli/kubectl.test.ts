import { describe, expect, it } from "vitest";
import { handleExec } from "../../../src/handle-exec";
import { buildDeps, NOW_MS, setTok } from "./_helpers";

describe("kubectl — exec credential plugin", () => {
  it("emits a v1 ExecCredential JSON envelope with token + expirationTimestamp", async () => {
    const deps = buildDeps();
    setTok(
      deps.resolver,
      "kubectl",
      "kubectl.cap.local",
      "tok_kube",
      undefined,
      NOW_MS + 3600_000,
    );
    const res = await handleExec(
      "kubectl",
      { principal: "p1", hostname: "kubectl.cap.local" },
      { env: { KUBERNETES_EXEC_INFO: '{"apiVersion":"client.authentication.k8s.io/v1","kind":"ExecCredential","spec":{}}' } },
      deps,
    );
    if (res.kind !== "stdout") throw new Error("expected stdout");
    const cred = JSON.parse(res.text);
    expect(cred.apiVersion).toBe("client.authentication.k8s.io/v1");
    expect(cred.kind).toBe("ExecCredential");
    expect(cred.status.token).toBe("tok_kube");
    expect(cred.status.expirationTimestamp).toBe("2026-05-09T13:00:00.000Z");
  });

  it("exits 1 with a stderr message when no credential is configured", async () => {
    const deps = buildDeps();
    const res = await handleExec(
      "kubectl",
      { principal: "p1", hostname: "kubectl.cap.local" },
      {},
      deps,
    );
    expect(res.kind).toBe("error");
    if (res.kind !== "error") return;
    expect(res.exit).toBe(1);
  });
});
