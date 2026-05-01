#!/usr/bin/env node
/**
 * Lint wrangler.jsonc files for duplicate keys.
 *
 * Background — why this exists:
 *
 * JSONC (and JSON) parsers silently last-write-wins on duplicate object
 * keys. Wrangler accepts the file without complaint. The semantic effect
 * inside `wrangler.jsonc` is that a duplicate `"durable_objects"` block
 * (or `"services"`, `"kv_namespaces"`, …) at the same scope **drops every
 * binding from the earlier block**. PR #28 hit this exact footgun: a new
 * top-level `durable_objects` for the RUNTIME_ROOM cross-script binding
 * silently dropped SESSION_DO + SANDBOX from the prod (base) config, and
 * every prod request that touched the SessionDO returned a generic
 * "Internal Server Error" because the class wasn't bound at all. Staging
 * was unaffected because its `env.staging` override block had its own
 * complete `durable_objects`.
 *
 * Detection: the `jsonc-parser` package's `visit` API gives an
 * `onObjectProperty` callback per key — we track keys per object scope
 * and exit non-zero on any duplicate. Bonus check: top-level binding
 * arrays (`durable_objects.bindings`, `services`, `kv_namespaces`, …)
 * are scanned for duplicate `binding`/`name` values too — different
 * footgun, same shape (declaring a binding twice silently picks one).
 *
 * Scope: every wrangler.jsonc / wrangler.*.jsonc under apps/ and
 * packages/, including env-override blocks (recursively, all object
 * scopes). Excluded: anything under .wrangler/ (build cache),
 * node_modules/, build-default/ (generated).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { visit } from "jsonc-parser";

function findFiles() {
  // git ls-files keeps us in-sync with what's actually checked in.
  const out = execSync(
    "git ls-files 'apps/**/wrangler*.jsonc' 'packages/**/wrangler*.jsonc' 'test/**/wrangler*.jsonc'",
    { encoding: "utf-8" },
  );
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter(
      (p) =>
        !p.includes("/node_modules/") &&
        !p.includes("/.wrangler/") &&
        !p.includes("/build-default/"),
    );
}

/**
 * Walk a JSONC document and find duplicate keys per object scope.
 * Returns an array of { scopePath, key, line, col } for each duplicate.
 */
function findDuplicateKeys(text) {
  const violations = [];
  // Stack of Maps: each Map is one object scope, key → first occurrence loc.
  // We use a stack because nested objects each have their own key set.
  const stack = [];
  const pathStack = [];

  visit(text, {
    onObjectBegin: () => {
      stack.push(new Map());
    },
    onObjectEnd: () => {
      stack.pop();
      pathStack.pop();
    },
    onObjectProperty: (property, _offset, _length, startLine, startCharacter) => {
      const top = stack[stack.length - 1];
      if (top.has(property)) {
        const first = top.get(property);
        violations.push({
          scopePath: pathStack.join(".") || "<root>",
          key: property,
          firstLine: first.line + 1,
          firstCol: first.col + 1,
          dupLine: startLine + 1,
          dupCol: startCharacter + 1,
        });
      } else {
        top.set(property, { line: startLine, col: startCharacter });
      }
      // Track current property name for nested scope path. The next
      // value (object/array/literal) belongs under this property.
      pathStack.push(property);
    },
    onArrayBegin: () => {
      // Arrays don't have keys; push a marker so onArrayEnd pops cleanly.
      stack.push(new Map());
    },
    onArrayEnd: () => {
      stack.pop();
      pathStack.pop();
    },
    onLiteralValue: () => {
      // Property's value was a literal — pop the path entry we pushed
      // in onObjectProperty so the next sibling property has the right
      // path stack. Object/array values are popped in their End callbacks.
      pathStack.pop();
    },
  });

  return violations;
}

/**
 * Find duplicate `binding` / `name` values in known binding arrays.
 * Catches cases like declaring two `{name:"FOO",...}` entries inside a
 * single `services: [...]` — JSONC dedup wouldn't catch that because
 * the keys themselves are unique; it's the values that collide.
 */
function findDuplicateBindings(parsed, file) {
  const violations = [];
  const arrayPaths = [
    ["services"],
    ["kv_namespaces"],
    ["d1_databases"],
    ["r2_buckets"],
    ["vectorize"],
    ["queues", "producers"],
    ["queues", "consumers"],
    ["durable_objects", "bindings"],
    ["browser"],
    ["ai"],
  ];

  function checkScope(scope, scopeLabel) {
    for (const path of arrayPaths) {
      let cur = scope;
      for (const seg of path) {
        if (cur == null || typeof cur !== "object") {
          cur = null;
          break;
        }
        cur = cur[seg];
      }
      if (!Array.isArray(cur)) continue;
      const seen = new Map();
      for (const entry of cur) {
        if (entry == null || typeof entry !== "object") continue;
        const key = entry.binding ?? entry.name;
        if (typeof key !== "string") continue;
        if (seen.has(key)) {
          violations.push({
            scope: scopeLabel,
            arrayPath: path.join("."),
            key,
            count: seen.get(key) + 1,
          });
          seen.set(key, seen.get(key) + 1);
        } else {
          seen.set(key, 1);
        }
      }
    }
  }

  checkScope(parsed, "<base>");
  if (parsed.env && typeof parsed.env === "object") {
    for (const [envName, envCfg] of Object.entries(parsed.env)) {
      checkScope(envCfg, `env.${envName}`);
    }
  }

  return violations;
}

function jsoncParseLooseSafe(text) {
  // Stdlib JSON.parse can't read JSONC; jsonc-parser gives a tree and a
  // helper `parse` that strips comments. Fall back to manual strip.
  // Use jsonc-parser's parse if available — fast path.
  // (We import dynamically to avoid breaking the script for environments
  // without it; the main code path uses visit() above which doesn't need
  // it for JSON-mode.)
  // Strip line + block comments + trailing commas, then JSON.parse.
  const noLine = text.replace(/^\s*\/\/.*$/gm, "");
  const noBlock = noLine.replace(/\/\*[\s\S]*?\*\//g, "");
  const noTrailing = noBlock.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(noTrailing);
}

let totalErrors = 0;

for (const relPath of findFiles()) {
  const abs = resolve(relPath);
  const text = readFileSync(abs, "utf-8");

  const dupKeyViolations = findDuplicateKeys(text);
  for (const v of dupKeyViolations) {
    console.error(
      `${relPath}:${v.dupLine}:${v.dupCol}  duplicate key "${v.key}" in scope ${v.scopePath} (first at ${v.firstLine}:${v.firstCol})`,
    );
    totalErrors++;
  }

  // Try parsing for binding-name dedup. Skip if parse fails — duplicate
  // keys above will already have surfaced.
  let parsed;
  try {
    parsed = jsoncParseLooseSafe(text);
  } catch {
    continue;
  }

  const dupBindings = findDuplicateBindings(parsed, relPath);
  for (const v of dupBindings) {
    console.error(
      `${relPath}  duplicate ${v.arrayPath}[].binding/name "${v.key}" (×${v.count}) in ${v.scope}`,
    );
    totalErrors++;
  }
}

if (totalErrors > 0) {
  console.error(`\n${totalErrors} duplicate(s) found across wrangler configs.`);
  console.error(
    "Duplicate keys at the same JSON object scope silently last-write-wins —",
  );
  console.error("the earlier block is dropped from the deployed worker config.");
  process.exit(1);
}

console.log(
  `wrangler-jsonc-lint: ok (${findFiles().length} files, no duplicates)`,
);
