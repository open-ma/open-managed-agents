#!/usr/bin/env node
// Lints src/** for any I/O imports or fetch calls. CAP is a pure-data +
// pure-function library — all I/O happens via injected ports. Any import of
// node:fs, node:http, node:https, node:net, node:tls, or any call to fetch
// indicates a leak of environment knowledge into the lib.
//
// Run as: node scripts/check-no-io.mjs
// Exit 0 if clean, exit 1 (with offending lines) on violation.

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const SRC = join(ROOT, "src");

const FORBIDDEN = [
  /from\s+["'](node:)?(fs|http|https|net|tls|dgram|dns|child_process|cluster|os|process)["']/,
  /from\s+["']node:fs\/promises["']/,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
];

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && entry.name.endsWith(".ts")) yield full;
  }
}

let bad = 0;
for await (const file of walk(SRC)) {
  const text = await readFile(file, "utf8");
  const lines = text.split("\n");
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Track /* ... */ block comments. Doesn't handle nested or
    // multi-comment-per-line edge cases, but our codebase doesn't have
    // those; if it grows them, switch to a real lexer.
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      continue;
    }

    // Skip pure-comment lines.
    if (trimmed.startsWith("//")) continue;

    // For lines mixing code and a trailing comment, strip the comment so
    // we only scan executable text.
    const commentIdx = stripTrailingComment(line);
    const code = commentIdx >= 0 ? line.slice(0, commentIdx) : line;

    for (const re of FORBIDDEN) {
      if (re.test(code)) {
        const rel = relative(ROOT, file);
        console.error(`${rel}:${i + 1}: forbidden I/O — ${line.trim()}`);
        bad++;
      }
    }
  }
}

if (bad > 0) {
  console.error(`\n${bad} I/O violation${bad === 1 ? "" : "s"} in src/. CAP must be pure.`);
  process.exit(1);
}
console.log("src/ is I/O-free ✓");

/**
 * Returns the index of the start of a trailing `//` comment in the line,
 * or -1 if there is none. Naive — doesn't track string literals, so
 * `"a // b"` would be misidentified. We don't have such strings in src/
 * today; if they appear, swap for a real tokenizer.
 */
function stripTrailingComment(line) {
  const idx = line.indexOf("//");
  if (idx < 0) return -1;
  // Conservative: only treat as comment if preceded by whitespace or
  // start-of-line (avoids `https://` matching).
  if (idx === 0) return 0;
  const prev = line[idx - 1];
  if (prev === " " || prev === "\t") return idx;
  return -1;
}
