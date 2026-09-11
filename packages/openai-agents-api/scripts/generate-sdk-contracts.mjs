// Generate structural JSON contracts from the audited SDK's public types.
// The compiler and SDK are build inputs only; production has no SDK dependency.
// Usage: TS_COMPILER_PATH=/path/typescript/lib/typescript.js node scripts/generate-sdk-contracts.mjs /path/openai/package
import { readFile, writeFile } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const ts = (await import(process.env.TS_COMPILER_PATH ? pathToFileURL(process.env.TS_COMPILER_PATH).href : "typescript")).default;
if (!ts.createProgram) throw new Error("Generation requires the TypeScript 5.x JavaScript compiler API; set TS_COMPILER_PATH.");
const require = createRequire(import.meta.url);
const sdk = resolve(process.argv[2] ?? dirname(require.resolve("openai/package.json")));
const version = JSON.parse(await readFile(resolve(sdk, "package.json"), "utf8")).version;
if (version !== "7.15.0") throw new Error(`Expected openai@7.15.0, got ${version}. Review the SDK audit before regenerating.`);
const files = ["agents", "environments/environments", "environments/files", "environments/templates", "sessions/sessions", "sessions/events", "sessions/items", "sessions/turns", "sessions/artifacts", "sessions/subagents/subagents", "sessions/subagents/items", "sessions/subagents/turns/turns", "sessions/subagents/turns/items", "vaults/vaults", "vaults/credentials"];
const sourceRoot = resolve(sdk, "src/resources/beta/agents");
const program = ts.createProgram(files.map(f => resolve(sourceRoot, `${f}.ts`)), { strict: true, skipLibCheck: true, target: ts.ScriptTarget.ESNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext });
const checker = program.getTypeChecker();
const descriptors = {};
const roots = {};
const seen = new Map();
function schema(type) {
  if (seen.has(type)) return seen.get(type);
  const id = `s${seen.size}`;
  seen.set(type, id);
  descriptors[id] = { kind: "unknown" };
  const flag = ts.TypeFlags;
  let result;
  if (type.flags & (flag.Any | flag.Unknown)) result = { kind: "unknown" };
  else if (type.flags & flag.StringLiteral) result = { kind: "literal", value: type.value };
  else if (type.flags & flag.NumberLiteral) result = { kind: "literal", value: type.value };
  else if (type.flags & flag.BooleanLiteral) result = { kind: "literal", value: type.intrinsicName === "true" };
  else if (type.flags & flag.String) result = { kind: "string" };
  else if (type.flags & flag.Number) result = { kind: "number" };
  else if (type.flags & flag.Boolean) result = { kind: "boolean" };
  else if (type.flags & flag.Null) result = { kind: "null" };
  else if (type.isUnion()) result = { kind: "union", variants: type.types.filter(t => !(t.flags & flag.Undefined)).map(schema) };
  else if (checker.isArrayType(type)) result = { kind: "array", element: schema(checker.getTypeArguments(type)[0]) };
  else if (type.flags & flag.Object || type.isIntersection()) {
    const properties = {};
    for (const prop of checker.getPropertiesOfType(type)) {
      const declaration = prop.valueDeclaration ?? prop.declarations?.[0];
      if (!declaration) throw new Error(`Cannot resolve ${prop.name}`);
      properties[prop.name] = { schema: schema(checker.getTypeOfSymbolAtLocation(prop, declaration)), required: !(prop.flags & ts.SymbolFlags.Optional) };
    }
    const index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    result = { kind: "object", properties, ...(index ? { additional: schema(index) } : {}) };
  } else if (type.flags & (flag.Never | flag.Undefined)) result = { kind: "never" };
  else throw new Error(`Unhandled type ${checker.typeToString(type)} flags=${type.flags}`);
  descriptors[id] = result;
  return id;
}
for (const file of files) {
  const source = program.getSourceFile(resolve(sourceRoot, `${file}.ts`));
  if (!source) throw new Error(`Missing SDK source ${file}`);
  const prefix = file.replace(/\/([^/]+)$/, (_match, name) => file.split("/").at(-2) === name ? "" : `/${name}`).replaceAll("/", ".");
  for (const statement of source.statements) {
    if ((!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) || !statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (/Page$/.test(statement.name.text)) continue;
    roots[`${prefix}.${statement.name.text}`] = schema(checker.getTypeAtLocation(statement));
  }
}
const output = resolve(dirname(fileURLToPath(import.meta.url)), "../src/sdk-contracts.generated.ts");
await writeFile(output, `// Generated from openai@${version}; regenerate with scripts/generate-sdk-contracts.mjs.\n// SDK-derived structural contracts. Handwritten validation adds documented bounds.\nexport const sdkContractRoots: Record<string, string> = ${JSON.stringify(roots, null, 2)};\nexport const sdkContractDescriptors = ${JSON.stringify(descriptors, null, 2)};\n`);
console.log(`Wrote ${Object.keys(roots).length} public contracts / ${Object.keys(descriptors).length} structural types to ${relative(process.cwd(), output)}`);
