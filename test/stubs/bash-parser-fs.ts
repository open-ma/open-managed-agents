// bash-parser's generated grammar exposes a Node CLI helper that is never
// called by OpenMA. Keeping a fail-closed stub lets Vite pre-bundle the parser
// for workerd without pulling a filesystem implementation into the Worker.
export function readFileSync(): never {
  throw new Error("bash-parser filesystem CLI is unavailable in Workers");
}
