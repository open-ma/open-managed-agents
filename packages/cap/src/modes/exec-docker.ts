// Docker credential helper protocol.
//
// Spec reference:
//   https://docs.docker.com/engine/reference/commandline/login/#credential-helper-protocol
//   https://github.com/docker/docker-credential-helpers
//
// Wire shape:
//   The helper binary is named docker-credential-<name>. docker invokes it
//   with one of {get, store, erase, list} as the first positional arg, then
//   pipes data on stdin and reads the result on stdout.
//
//   get:   stdin = ServerURL string (one line)
//          stdout = { "ServerURL": "...", "Username": "...", "Secret": "..." }
//                   or `{}` to signal "no credential available"
//   store: stdin = JSON {ServerURL, Username, Secret}, stdout empty
//   erase: stdin = ServerURL, stdout empty
//   list:  stdout = JSON { "ServerURL": "Username", ... }
//
// CAP only services `get` (and emits `{}` no-op responses for the other
// subcommands so docker doesn't crash). store/erase are no-ops because the
// canonical credential store IS the vault — docker shouldn't be writing
// to it via this side channel.

import type { ExecHandleResult, ExecHelperInput } from "../types";
import type { ResolvedToken } from "../ports";
import { MalformedHelperInputError } from "../errors";

const DEFAULT_USERNAME = "oauth2accesstoken";

export function applyDockerExec(
  _cli_id: string,
  token: ResolvedToken | null,
  input: ExecHelperInput,
): ExecHandleResult {
  const sub = input.args?.[0];
  if (!sub) {
    throw new MalformedHelperInputError(
      `docker credential helper requires a subcommand (get|store|erase|list)`,
    );
  }

  switch (sub) {
    case "get":
      return handleGet(token, input);
    case "store":
    case "erase":
      // No-op success. Docker cli uses these to mutate the credential
      // store; CAP's credential store is the vault, mutated through
      // resolver.store() not through docker.
      return ok("");
    case "list":
      return handleList(token);
    default:
      throw new MalformedHelperInputError(
        `docker credential helper got unknown subcommand: ${sub}`,
      );
  }
}

function handleGet(
  token: ResolvedToken | null,
  input: ExecHelperInput,
): ExecHandleResult {
  if (input.stdin === undefined || input.stdin.trim() === "") {
    throw new MalformedHelperInputError(
      `docker credential helper "get" expects ServerURL on stdin`,
    );
  }
  const serverUrl = input.stdin.trim();

  if (token === null) return ok("{}");

  return ok(
    JSON.stringify({
      ServerURL: serverUrl,
      Username: token.extras?.username ?? DEFAULT_USERNAME,
      Secret: token.token,
    }),
  );
}

function handleList(token: ResolvedToken | null): ExecHandleResult {
  if (token === null) return ok("{}");
  // We don't know which ServerURL the token is scoped to without context;
  // emit a generic placeholder so docker's cli doesn't error. The realistic
  // use case for `list` is informational anyway.
  return ok(
    JSON.stringify({
      "*": token.extras?.username ?? DEFAULT_USERNAME,
    }),
  );
}

function ok(text: string): ExecHandleResult {
  return { kind: "stdout", text, exit: 0 };
}
