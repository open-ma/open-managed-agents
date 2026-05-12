import { describe, it, expect } from "vitest";
import { applyKubectlExec } from "../../../src/modes/exec-kubectl";
import { ManualClock } from "../../../src/test-fakes";

const NOW = Date.UTC(2026, 4, 9, 12, 0, 0);

describe("applyKubectlExec — token present", () => {
  it("returns kind=stdout exit=0", () => {
    const out = applyKubectlExec(
      "kubectl",
      { token: "tok_abc", expires_at: NOW + 3600_000 },
      {},
      new ManualClock(NOW),
    );
    expect(out.kind).toBe("stdout");
    if (out.kind !== "stdout") return;
    expect(out.exit).toBe(0);
  });

  it("emits a valid client.authentication.k8s.io/v1 ExecCredential", () => {
    const out = applyKubectlExec(
      "kubectl",
      { token: "tok_abc", expires_at: NOW + 3600_000 },
      {},
      new ManualClock(NOW),
    );
    if (out.kind !== "stdout") throw new Error("expected stdout");
    const cred = JSON.parse(out.text);
    expect(cred.apiVersion).toBe("client.authentication.k8s.io/v1");
    expect(cred.kind).toBe("ExecCredential");
    expect(cred.status.token).toBe("tok_abc");
  });

  it("expirationTimestamp is RFC3339 / ISO8601 from expires_at", () => {
    const out = applyKubectlExec(
      "kubectl",
      { token: "tok_abc", expires_at: Date.UTC(2026, 4, 9, 12, 30, 45) },
      {},
      new ManualClock(NOW),
    );
    if (out.kind !== "stdout") throw new Error("expected stdout");
    const cred = JSON.parse(out.text);
    expect(cred.status.expirationTimestamp).toBe("2026-05-09T12:30:45.000Z");
  });

  it("omits expirationTimestamp when expires_at is missing (kubectl falls back to invoking helper again on next request)", () => {
    const out = applyKubectlExec(
      "kubectl",
      { token: "tok_abc" },
      {},
      new ManualClock(NOW),
    );
    if (out.kind !== "stdout") throw new Error("expected stdout");
    const cred = JSON.parse(out.text);
    expect(cred.status.token).toBe("tok_abc");
    expect("expirationTimestamp" in cred.status).toBe(false);
  });
});

describe("applyKubectlExec — null token", () => {
  it("returns kind=error with non-zero exit and a stderr-friendly message", () => {
    const out = applyKubectlExec(
      "kubectl",
      null,
      {},
      new ManualClock(NOW),
    );
    expect(out.kind).toBe("error");
    if (out.kind !== "error") return;
    expect(out.exit).not.toBe(0);
    expect(out.message.toLowerCase()).toContain("credential");
  });
});

describe("applyKubectlExec — output formatting", () => {
  it("output is single-line JSON (not pretty-printed)", () => {
    const out = applyKubectlExec(
      "kubectl",
      { token: "tok", expires_at: NOW + 1_000 },
      {},
      new ManualClock(NOW),
    );
    if (out.kind !== "stdout") throw new Error("expected stdout");
    expect(out.text.split("\n")).toHaveLength(1);
  });

  it("output ends without trailing newline (the L4 binary may add one when writing to stdout)", () => {
    const out = applyKubectlExec(
      "kubectl",
      { token: "tok", expires_at: NOW + 1_000 },
      {},
      new ManualClock(NOW),
    );
    if (out.kind !== "stdout") throw new Error("expected stdout");
    expect(out.text.endsWith("\n")).toBe(false);
  });
});
