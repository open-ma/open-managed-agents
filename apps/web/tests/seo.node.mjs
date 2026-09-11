import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { websiteSchema } from "../src/lib/seo.ts";
import worker from "../src/worker.ts";

const assets = {
  async fetch(request) {
    return new Response("asset", {
      headers: { "x-asset-url": request.url },
    });
  },
};

async function fetchFromWorker(url) {
  return worker.fetch(new Request(url), { ASSETS: assets });
}

test("legacy Anthropic article URLs permanently redirect to the live Claude URLs", async () => {
  const redirects = new Map([
    [
      "/blog/open-source-alternatives-to-anthropic-managed-agents-2026/",
      "/blog/open-source-alternatives-to-claude-managed-agents-2026/",
    ],
    [
      "/blog/migrate-from-anthropic-managed-agents/",
      "/blog/migrate-from-claude-managed-agents/",
    ],
    [
      "/blog/anthropic-managed-agents-vs-open-managed-agents/",
      "/blog/claude-managed-agents-vs-open-managed-agents/",
    ],
  ]);

  for (const [from, to] of redirects) {
    const response = await fetchFromWorker(`https://openma.dev${from}?ref=old-link`);

    assert.equal(response.status, 301, from);
    assert.equal(
      response.headers.get("location"),
      `https://openma.dev${to}?ref=old-link`,
      from,
    );
  }
});

test("extensionless marketing URLs permanently redirect to their trailing-slash canonical", async () => {
  const response = await fetchFromWorker(
    "https://openma.dev/blog/architecture-durable-objects-r2-brain-sandbox-split?source=gsc",
  );

  assert.equal(response.status, 301);
  assert.equal(
    response.headers.get("location"),
    "https://openma.dev/blog/architecture-durable-objects-r2-brain-sandbox-split/?source=gsc",
  );
});

test("static assets bypass trailing-slash redirects", async () => {
  const response = await fetchFromWorker("https://openma.dev/robots.txt");

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("x-asset-url"),
    "https://openma.dev/robots.txt",
  );
});

test("API-shaped paths bypass marketing trailing-slash redirects", async () => {
  const response = await fetchFromWorker("https://openma.dev/v1/agents");

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("x-asset-url"),
    "https://openma.dev/v1/agents",
  );
});

test("WebSite structured data does not advertise a search endpoint that returns 404", () => {
  const schema = websiteSchema();

  assert.equal("potentialAction" in schema, false);
});

test("high-impression landing pages emit concise, user-facing search snippets", async () => {
  const homepage = await readFile(
    new URL("../dist/index.html", import.meta.url),
    "utf8",
  );
  const alternative = await readFile(
    new URL("../dist/claude-tag-alternative/index.html", import.meta.url),
    "utf8",
  );

  const title = homepage.match(/<title>([^<]+)<\/title>/)?.[1];
  const description = homepage.match(/<meta name="description" content="([^"]+)"/)?.[1];
  assert.match(title, /OpenMA/);
  assert.match(title, /Claude Managed Agents/);
  assert.match(title, /OpenAI Agents API/);
  assert.ok(title.length <= 65, "homepage title stays concise");
  assert.match(description, /Self-host/);
  assert.match(description, /OpenAI.*Node/);
  assert.ok(description.length <= 170, "homepage description stays concise");
  assert.equal(homepage.match(/<meta property="og:description" content="([^"]+)"/)?.[1], description);
  assert.match(homepage, /href="#openai-agents-api"/);
  assert.match(homepage, /id="openai-agents-api"/);
  assert.match(
    alternative,
    /<title>Open-Source Claude Tag Alternative You Can Self-Host \| OpenMA<\/title>/,
  );
  assert.match(
    alternative,
    /<meta name="description" content="Build a Claude Tag-style agent on Docker or Cloudflare with Slack, MCP, private tools, durable sessions and BYOK models\. Apache-2\.0\."/,
  );
  assert.match(
    alternative,
    /href="https:\/\/docs\.openma\.dev\/build\/vault-and-mcp\/"/,
  );
  assert.doesNotMatch(alternative, /Search intent match/i);
});

test("generated pages do not expose internal SEO language to visitors", async () => {
  const pagePaths = [
    "../dist/claude-tag-alternative/index.html",
    "../dist/claude-tag-open-source/index.html",
    "../dist/self-hosted-claude-tag/index.html",
  ];

  for (const pagePath of pagePaths) {
    const html = await readFile(new URL(pagePath, import.meta.url), "utf8");
    assert.doesNotMatch(
      html,
      /Search intent match|matters for SEO|The SEO and product category/i,
      pagePath,
    );
  }
});
