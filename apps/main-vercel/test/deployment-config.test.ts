import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

async function jsonFile(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8")) as Record<string, unknown>;
}

describe("Vercel deployment manifests", () => {
  it("keeps production and anonymous-preview routing/function settings identical", async () => {
    const production = await jsonFile("vercel.json");
    const temporary = await jsonFile("vercel.openma.temporary.json");

    expect(temporary).not.toHaveProperty("buildCommand");
    expect(production).not.toHaveProperty("buildCommand");
    expect(temporary).not.toHaveProperty("installCommand");
    expect(production).not.toHaveProperty("installCommand");
    expect(temporary.functions).toEqual(production.functions);
    expect(production.functions).toHaveProperty("api/index.mjs");
    expect(temporary.rewrites).toEqual(production.rewrites);
    expect(temporary).not.toHaveProperty("crons");
    expect(production.crons).toEqual([{
      path: "/api/openma/environment/poll",
      schedule: "* * * * *",
    }]);
  });

  it("keeps the deployable entry and migrations while excluding local bulk", async () => {
    const ignore = await readFile(resolve(repositoryRoot, ".vercelignore"), "utf8");
    const entry = await readFile(resolve(repositoryRoot, "api/index.mjs"), "utf8");
    const rootPackage = await jsonFile("package.json") as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    const vercelPackage = await jsonFile("apps/main-vercel/package.json") as {
      exports?: Record<string, string>;
    };

    expect(ignore).toContain(".vercel/");
    expect(ignore).toContain("apps/console/");
    expect(ignore).toContain("**/*.test.ts");
    expect(ignore).not.toContain("api/");
    expect(ignore).not.toContain("apps/main-node/migrations/");
    expect(entry).toContain("import(\"../apps/main-vercel/dist/api.mjs\")");
    expect(rootPackage.scripts?.["build:vercel"])
      .toBe("node apps/main-vercel/scripts/build-function.mjs");
    expect(rootPackage.scripts?.["vercel-build"]).toBe("pnpm build:vercel");
    expect(rootPackage.devDependencies?.esbuild).toBeDefined();
    expect(vercelPackage.exports?.["./api"]).toBe("./api/index.ts");
  });
});
