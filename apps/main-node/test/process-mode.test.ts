import { describe, expect, it } from "vitest";

import {
  resolveNodeProcessMode,
  validateNodeProcessEnvironment,
} from "../src/process-mode";

const durableServerlessEnvironment = {
  OPENMA_PROCESS_MODE: "serverless",
  DATABASE_URL: "postgresql://openma:secret@db.example.test/openma",
  PUBLIC_BASE_URL: "https://control.example.test",
  BETTER_AUTH_SECRET: "auth-secret",
  PLATFORM_ROOT_SECRET: "platform-secret",
  MEMORY_S3_ENDPOINT: "https://object.example.test",
  MEMORY_S3_BUCKET: "memory",
  MEMORY_S3_ACCESS_KEY: "access",
  MEMORY_S3_SECRET_KEY: "secret",
  FILES_S3_ENDPOINT: "https://object.example.test",
  FILES_S3_BUCKET: "files",
  FILES_S3_ACCESS_KEY: "access",
  FILES_S3_SECRET_KEY: "secret",
} as const;

describe("main-node process mode", () => {
  it("defaults to the long-lived standalone process", () => {
    expect(resolveNodeProcessMode({})).toBe("standalone");
    expect(resolveNodeProcessMode({ OPENMA_PROCESS_MODE: "standalone" })).toBe("standalone");
  });

  it("accepts a durable Postgres + object-store serverless composition", () => {
    expect(resolveNodeProcessMode(durableServerlessEnvironment)).toBe("serverless");
    expect(() => validateNodeProcessEnvironment(durableServerlessEnvironment)).not.toThrow();
  });

  it.each([
    ["SQLite", { DATABASE_URL: undefined }, "DATABASE_URL must be PostgreSQL"],
    ["MySQL", { DATABASE_URL: "mysql://db/openma" }, "DATABASE_URL must be PostgreSQL"],
    ["public origin", { PUBLIC_BASE_URL: undefined }, "PUBLIC_BASE_URL"],
    ["stable auth secret", { BETTER_AUTH_SECRET: undefined }, "BETTER_AUTH_SECRET"],
    ["platform root secret", { PLATFORM_ROOT_SECRET: undefined }, "PLATFORM_ROOT_SECRET"],
    ["memory object store", { MEMORY_S3_BUCKET: undefined }, "MEMORY_S3_BUCKET"],
    ["file object store", { FILES_S3_SECRET_KEY: undefined }, "FILES_S3_SECRET_KEY"],
  ])("fails closed without %s", (_name, overrides, message) => {
    const environment = { ...durableServerlessEnvironment, ...overrides };
    expect(() => validateNodeProcessEnvironment(environment)).toThrow(message);
  });

  it("does not require an auth secret when authentication is explicitly disabled", () => {
    expect(() => validateNodeProcessEnvironment({
      ...durableServerlessEnvironment,
      AUTH_DISABLED: "1",
      BETTER_AUTH_SECRET: undefined,
    })).not.toThrow();
  });

  it("rejects unknown process modes", () => {
    expect(() => resolveNodeProcessMode({ OPENMA_PROCESS_MODE: "lambda-ish" }))
      .toThrow("OPENMA_PROCESS_MODE");
  });
});
