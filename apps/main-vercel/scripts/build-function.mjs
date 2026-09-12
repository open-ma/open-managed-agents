import { createHash } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const applicationRoot = resolve(import.meta.dirname, "..");
const defaultEntryPoint = resolve(applicationRoot, "api/index.ts");
const defaultOutputFile = resolve(applicationRoot, "dist/api.mjs");

/**
 * Bundle the TypeScript-exporting OpenMA workspace into one Vercel Function
 * module. Vercel's own packages remain external so their CommonJS/native
 * dependency graphs are traced by the platform instead of rewritten into ESM.
 *
 * @param {{ entryPoint?: string, outputFile?: string }} [options]
 */
export async function buildVercelFunction(options = {}) {
  const entryPoint = resolve(options.entryPoint ?? defaultEntryPoint);
  const outputFile = resolve(options.outputFile ?? defaultOutputFile);
  const temporaryOutput = `${outputFile}.${process.pid}.tmp.mjs`;

  await mkdir(dirname(outputFile), { recursive: true });
  try {
    await build({
      entryPoints: [entryPoint],
      outfile: temporaryOutput,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      treeShaking: true,
      minify: true,
      keepNames: true,
      legalComments: "none",
      external: ["@vercel/functions", "@vercel/sandbox"],
      logLevel: "warning",
      metafile: true,
    });
    await rename(temporaryOutput, outputFile);
    const bytes = await readFile(outputFile);
    return {
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    await rm(temporaryOutput, { force: true });
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const artifact = await buildVercelFunction();
  console.log(`openma-vercel-bundle bytes=${artifact.bytes} sha256=${artifact.sha256}`);
}
