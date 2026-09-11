import { Readable, Writable } from "node:stream";

import { createNodeManagedAcpSupervisorApp } from "./node-supervisor.js";

await createNodeManagedAcpSupervisorApp().serve({
  // Node's stream/web declarations and the DOM declarations model distinct
  // nominal BYOB reader/writer types even though the runtime objects implement
  // the same WHATWG contract expected by the supervisor.
  input: Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  output: Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
});
