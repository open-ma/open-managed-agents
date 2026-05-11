import { describe, expect, it } from "vitest";
import { handleHttp } from "../../../src/handle-http";
import { buildDeps, get, setTok, NOW_MS } from "./_helpers";

describe("aws — Container Credentials emulation", () => {
  it("returns AWS Container Credentials JSON when authenticated", async () => {
    const deps = buildDeps();
    setTok(
      deps.resolver,
      "aws",
      "169.254.170.2",
      "secret_xyz",
      { access_key_id: "AKIATESTING", session_token: "FQoDYXdz..." },
      NOW_MS + 3600_000,
    );
    // bootstrap.env says AWS_CONTAINER_AUTHORIZATION_TOKEN must equal
    // "__cap_managed__" (the sentinel); the L4 adapter would have replaced
    // this with a real bootstrap secret in production. For the test we
    // match the sentinel literally.
    const out = await handleHttp(
      get("http://169.254.170.2/cap/aws-creds", { Authorization: "__cap_managed__" }),
      { principal: "p1" },
      deps,
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    expect(out.res.status).toBe(200);
    const body = JSON.parse(out.res.body);
    expect(body).toEqual({
      AccessKeyId: "AKIATESTING",
      SecretAccessKey: "secret_xyz",
      Token: "FQoDYXdz...",
      Expiration: "2026-05-09T13:00:00.000Z",
    });
  });

  it("returns 401 when the bootstrap-token header is wrong", async () => {
    const deps = buildDeps();
    setTok(
      deps.resolver,
      "aws",
      "169.254.170.2",
      "secret",
      { access_key_id: "AKIA" },
      NOW_MS + 3600_000,
    );
    const out = await handleHttp(
      get("http://169.254.170.2/cap/aws-creds", { Authorization: "wrong_secret" }),
      { principal: "p1" },
      deps,
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    expect(out.res.status).toBe(401);
  });
});
