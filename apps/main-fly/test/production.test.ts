import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "smol-toml";

import { prepareFlyMachineEnvironment } from "../src/production";

describe("Fly Machine production adapter", () => {
  it("derives a secure public origin and binds every local durable path to the Fly volume", () => {
    const environment: Record<string, string | undefined> = {
      FLY_APP_NAME: "openma-demo",
      SANDBOX_PROVIDER: "e2b",
    };

    prepareFlyMachineEnvironment(environment);

    expect(environment.PUBLIC_BASE_URL).toBe("https://openma-demo.fly.dev");
    expect(environment.GATEWAY_ORIGIN).toBe("https://openma-demo.fly.dev");
    expect(environment.OPENMA_PROCESS_MODE).toBe("standalone");
    expect(environment.HOST).toBe("0.0.0.0");
    expect(environment.PORT).toBe("8080");
    expect(environment.DATABASE_PATH).toBe("/app/data/oma.db");
    expect(environment.AUTH_DATABASE_PATH).toBe("/app/data/auth.db");
    expect(environment.SANDBOX_WORKDIR).toBe("/app/data/sandboxes");
    expect(environment.MEMORY_BLOB_DIR).toBe("/app/data/memory-blobs");
    expect(environment.FILES_BLOB_DIR).toBe("/app/data/files-blobs");
    expect(environment.SESSION_OUTPUTS_DIR).toBe("/app/data/session-outputs");
  });

  it("preserves operator overrides and rejects an unsafe Fly app name", () => {
    const environment: Record<string, string | undefined> = {
      FLY_APP_NAME: "openma-demo",
      PUBLIC_BASE_URL: "https://agents.example.com",
      DATABASE_PATH: "/mnt/openma/state.db",
      PORT: "8787",
      SANDBOX_PROVIDER: "daytona",
    };

    prepareFlyMachineEnvironment(environment);

    expect(environment.PUBLIC_BASE_URL).toBe("https://agents.example.com");
    expect(environment.GATEWAY_ORIGIN).toBe("https://agents.example.com");
    expect(environment.DATABASE_PATH).toBe("/mnt/openma/state.db");
    expect(environment.PORT).toBe("8787");
    expect(() => prepareFlyMachineEnvironment({
      FLY_APP_NAME: "bad/name",
      SANDBOX_PROVIDER: "e2b",
    }))
      .toThrow(/FLY_APP_NAME/);
  });

  it.each([undefined, "", "subprocess", " SubProcess "])(
    "fails closed without an isolated sandbox provider (%s)",
    (provider) => {
      expect(() => prepareFlyMachineEnvironment({
        FLY_APP_NAME: "openma-demo",
        SANDBOX_PROVIDER: provider,
      })).toThrow(/isolated SANDBOX_PROVIDER/);
    },
  );

  it("ships a single-Machine Fly contract with health-gated volume persistence", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../../../fly.toml"), "utf8");
    const config = parse(source) as Record<string, any>;

    expect(config.build.dockerfile).toBe("apps/main-node/Dockerfile");
    expect(config.processes.app).toBe("pnpm --filter @open-managed-agents/main-fly start");
    expect(config.http_service.internal_port).toBe(8080);
    expect(config.http_service.auto_stop_machines).toBe("off");
    expect(config.http_service.min_machines_running).toBe(1);
    expect(config.http_service.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "GET", path: "/health" }),
    ]));
    expect(config.mounts).toEqual([
      expect.objectContaining({
        source: "openma_data",
        destination: "/app/data",
        initial_size: "10gb",
        snapshot_retention: 14,
      }),
    ]);
    expect(config.vm).toHaveLength(1);
  });
});
