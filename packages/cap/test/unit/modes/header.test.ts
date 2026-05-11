import { describe, it, expect } from "vitest";
import { applyHeader } from "../../../src/modes/header";
import type { CapSpec, HttpReqLike } from "../../../src/types";

const ghSpec: CapSpec = {
  cli_id: "gh",
  description: "GitHub CLI",
  endpoints: ["api.github.com"],
  inject_mode: "header",
  header: {
    strip: ["authorization"],
    set: { name: "Authorization", value: "Bearer ${token}" },
  },
};

const multiStripSpec: CapSpec = {
  cli_id: "multi",
  description: "Spec stripping multiple aliases",
  endpoints: ["api.example.com"],
  inject_mode: "header",
  header: {
    strip: ["authorization", "x-api-key", "x-auth-token"],
    set: { name: "Authorization", value: "Bearer ${token}" },
  },
};

const customHeaderSpec: CapSpec = {
  cli_id: "custom",
  description: "Spec setting a non-Authorization header",
  endpoints: ["api.example.com"],
  inject_mode: "header",
  header: {
    strip: ["x-api-key"],
    set: { name: "X-API-Key", value: "${token}" },
  },
};

const bodyBytes = new TextEncoder().encode("hello world").buffer as ArrayBuffer;

function req(
  url: string,
  headers: Record<string, string>,
  method = "GET",
  body: ArrayBuffer | null = null,
): HttpReqLike {
  return { url, method, headers, body };
}

describe("applyHeader — token present", () => {
  it("returns kind=forward with the rewritten request", () => {
    const out = applyHeader(ghSpec, { token: "tok_gh" }, req("https://api.github.com/x", {}));
    expect(out.kind).toBe("forward");
  });

  it("sets the Authorization header with ${token} substituted", () => {
    const out = applyHeader(ghSpec, { token: "tok_gh" }, req("https://api.github.com/x", {}));
    if (out.kind !== "forward") throw new Error("expected forward");
    expect(out.req.headers["Authorization"]).toBe("Bearer tok_gh");
  });

  it("strips the existing Authorization header before setting the new one", () => {
    const out = applyHeader(
      ghSpec,
      { token: "tok_gh" },
      req("https://api.github.com/x", { Authorization: "Bearer evil_smuggled" }),
    );
    if (out.kind !== "forward") throw new Error("expected forward");
    // Resulting headers should have exactly one Authorization with our token,
    // never the smuggled one.
    const values = Object.entries(out.req.headers)
      .filter(([k]) => k.toLowerCase() === "authorization")
      .map(([, v]) => v);
    expect(values).toEqual(["Bearer tok_gh"]);
  });

  it("strip is case-insensitive on incoming header names", () => {
    const out = applyHeader(
      ghSpec,
      { token: "tok_gh" },
      req("https://api.github.com/x", { AUTHORIZATION: "Bearer evil" }),
    );
    if (out.kind !== "forward") throw new Error("expected forward");
    const values = Object.entries(out.req.headers)
      .filter(([k]) => k.toLowerCase() === "authorization")
      .map(([, v]) => v);
    expect(values).toEqual(["Bearer tok_gh"]);
  });

  it("strip is case-insensitive on the spec's strip list entries", () => {
    const spec: CapSpec = {
      ...ghSpec,
      header: {
        strip: ["AUTHORIZATION"],
        set: { name: "Authorization", value: "Bearer ${token}" },
      },
    };
    const out = applyHeader(
      spec,
      { token: "tok_gh" },
      req("https://api.github.com/x", { authorization: "Bearer evil" }),
    );
    if (out.kind !== "forward") throw new Error("expected forward");
    const values = Object.entries(out.req.headers)
      .filter(([k]) => k.toLowerCase() === "authorization")
      .map(([, v]) => v);
    expect(values).toEqual(["Bearer tok_gh"]);
  });

  it("strips every entry in the strip list", () => {
    const out = applyHeader(
      multiStripSpec,
      { token: "tok_x" },
      req("https://api.example.com/x", {
        Authorization: "Bearer evil",
        "X-Api-Key": "k1",
        "X-Auth-Token": "k2",
        "x-other": "kept",
      }),
    );
    if (out.kind !== "forward") throw new Error("expected forward");
    const lowerKeys = Object.keys(out.req.headers).map((k) => k.toLowerCase());
    expect(lowerKeys).not.toContain("x-api-key");
    expect(lowerKeys).not.toContain("x-auth-token");
    expect(lowerKeys).toContain("x-other");
    expect(lowerKeys).toContain("authorization");
  });

  it("sets a non-Authorization header when the spec specifies one", () => {
    const out = applyHeader(
      customHeaderSpec,
      { token: "abc" },
      req("https://api.example.com/x", {}),
    );
    if (out.kind !== "forward") throw new Error("expected forward");
    expect(out.req.headers["X-API-Key"]).toBe("abc");
  });

  it("preserves headers that aren't in the strip list", () => {
    const out = applyHeader(
      ghSpec,
      { token: "tok_gh" },
      req("https://api.github.com/x", {
        "User-Agent": "gh/2.0",
        "Content-Type": "application/json",
      }),
    );
    if (out.kind !== "forward") throw new Error("expected forward");
    expect(out.req.headers["User-Agent"]).toBe("gh/2.0");
    expect(out.req.headers["Content-Type"]).toBe("application/json");
  });

  it("preserves url, method, and body", () => {
    const out = applyHeader(
      ghSpec,
      { token: "tok_gh" },
      req("https://api.github.com/repos", { "Content-Type": "application/json" }, "POST", bodyBytes),
    );
    if (out.kind !== "forward") throw new Error("expected forward");
    expect(out.req.url).toBe("https://api.github.com/repos");
    expect(out.req.method).toBe("POST");
    expect(out.req.body).toBe(bodyBytes);
  });

  it("does not mutate the input request's headers object", () => {
    const inputHeaders = { Authorization: "Bearer evil" };
    const r = req("https://api.github.com/x", inputHeaders);
    applyHeader(ghSpec, { token: "tok_gh" }, r);
    expect(inputHeaders).toEqual({ Authorization: "Bearer evil" });
  });
});

describe("applyHeader — no token", () => {
  it("returns kind=passthrough when token is null", () => {
    const out = applyHeader(ghSpec, null, req("https://api.github.com/x", {}));
    expect(out).toEqual({ kind: "passthrough" });
  });

  it("returns passthrough even if the request brings its own auth header (don't strip on no-token paths — the upstream owns the 401 response)", () => {
    // Rationale: header_inject's "no-creds" reply is upstream-driven. If
    // CAP can't add a token, it must not interfere with whatever the CLI
    // sends — even a stale one. Otherwise CAP stripping the only header
    // forces a 401 the user can't debug ("why does my Authorization
    // header keep disappearing?").
    const out = applyHeader(
      ghSpec,
      null,
      req("https://api.github.com/x", { Authorization: "Bearer user_token" }),
    );
    expect(out).toEqual({ kind: "passthrough" });
  });
});

describe("applyHeader — template substitution", () => {
  it("substitutes ${token} mid-value", () => {
    const spec: CapSpec = {
      ...ghSpec,
      header: { strip: [], set: { name: "Authorization", value: "token ${token}" } },
    };
    const out = applyHeader(spec, { token: "abc" }, req("https://api.github.com/x", {}));
    if (out.kind !== "forward") throw new Error("expected forward");
    expect(out.req.headers["Authorization"]).toBe("token abc");
  });

  it("substitutes ${token} when it is the whole value", () => {
    const spec: CapSpec = {
      ...ghSpec,
      header: { strip: [], set: { name: "X-Token", value: "${token}" } },
    };
    const out = applyHeader(spec, { token: "abc" }, req("https://api.github.com/x", {}));
    if (out.kind !== "forward") throw new Error("expected forward");
    expect(out.req.headers["X-Token"]).toBe("abc");
  });

  it("does not interpret other ${...} occurrences", () => {
    // Only ${token} is recognized. Other ${vars} are passed through
    // verbatim — protecting against accidental injection of token-like
    // strings into headers that didn't ask for them.
    const spec: CapSpec = {
      ...ghSpec,
      header: { strip: [], set: { name: "X-Wat", value: "${other}-${token}-${unrelated}" } },
    };
    const out = applyHeader(spec, { token: "abc" }, req("https://api.github.com/x", {}));
    if (out.kind !== "forward") throw new Error("expected forward");
    expect(out.req.headers["X-Wat"]).toBe("${other}-abc-${unrelated}");
  });
});
