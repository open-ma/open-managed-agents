import { describe, expect, it } from "vitest";

import { createProductionVercelControlPlane } from "../src/production";

describe("production Vercel composition", () => {
  it("loads without control-worker configuration and fails that boundary as 503", async () => {
    const environment: Record<string, string | undefined> = {
      VERCEL_PROJECT_PRODUCTION_URL: "openma-demo.vercel.app",
    };

    const controlPlane = createProductionVercelControlPlane(environment);
    const response = await controlPlane.fetch(new Request(
      "https://control.example.test/api/openma/environment/poll",
      { headers: { authorization: "Bearer configured-later" } },
    ));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "cron_not_configured" });
    expect(environment.OPENMA_PROCESS_MODE).toBe("serverless");
    expect(environment.PUBLIC_BASE_URL).toBe("https://openma-demo.vercel.app");
  });

  it("preserves an explicit public base URL over Vercel system metadata", () => {
    const environment: Record<string, string | undefined> = {
      PUBLIC_BASE_URL: "https://custom.example.test",
      VERCEL_PROJECT_PRODUCTION_URL: "openma-demo.vercel.app",
    };

    createProductionVercelControlPlane(environment);

    expect(environment.PUBLIC_BASE_URL).toBe("https://custom.example.test");
  });
});
