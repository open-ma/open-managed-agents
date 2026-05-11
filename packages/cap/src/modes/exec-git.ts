// git credential helper protocol.
//
// Spec reference: https://git-scm.com/docs/git-credential
//
// Wire shape:
//   git invokes a binary named git-credential-<name> with one of
//   {get, store, erase} as the first positional arg. stdin is a key=value
//   block terminated by a blank line; stdout is the same shape.
//
//   get   stdin:  protocol=https\nhost=github.com\n\n
//          stdout: protocol=https\nhost=github.com\nusername=...\npassword=...\n\n
//                  or empty (then git tries the next helper or prompts)
//   store stdin:  full credential block, stdout empty
//   erase stdin:  full credential block, stdout empty
//
// CAP only services `get`. store/erase are no-ops because the vault is the
// authoritative credential store; git shouldn't be writing into it via this
// side channel.

import type { ExecHandleResult, ExecHelperInput } from "../types";
import type { ResolvedToken } from "../ports";
import { MalformedHelperInputError } from "../errors";

const DEFAULT_USERNAME = "x-access-token";

export function applyGitExec(
  _cli_id: string,
  token: ResolvedToken | null,
  input: ExecHelperInput,
): ExecHandleResult {
  const sub = input.args?.[0];
  if (!sub) {
    throw new MalformedHelperInputError(
      `git credential helper requires a subcommand (get|store|erase)`,
    );
  }

  switch (sub) {
    case "get":
      return handleGet(token, input);
    case "store":
    case "erase":
      return ok("");
    default:
      throw new MalformedHelperInputError(
        `git credential helper got unknown subcommand: ${sub}`,
      );
  }
}

function handleGet(
  token: ResolvedToken | null,
  input: ExecHelperInput,
): ExecHandleResult {
  if (input.stdin === undefined) {
    throw new MalformedHelperInputError(
      `git credential helper "get" expects key=value stdin terminated by blank line`,
    );
  }
  const fields = parseGitInput(input.stdin);
  const protocol = fields.get("protocol");
  const host = fields.get("host");
  if (!protocol) {
    throw new MalformedHelperInputError(
      `git credential helper "get" stdin missing required key: protocol`,
    );
  }
  if (!host) {
    throw new MalformedHelperInputError(
      `git credential helper "get" stdin missing required key: host`,
    );
  }

  if (token === null) return ok("");

  const username = token.extras?.username ?? DEFAULT_USERNAME;
  return ok(
    `protocol=${protocol}\nhost=${host}\nusername=${username}\npassword=${token.token}\n\n`,
  );
}

/**
 * Parse the `key=value\n…\n\n` block git pipes to credential helpers.
 * Requires a blank-line terminator (`\n\n`); throws otherwise. The
 * trailing-newline-from-stdin artifact (single `\n` at end-of-input) is
 * NOT enough — git's contract is an explicit blank line.
 */
function parseGitInput(raw: string): Map<string, string> {
  if (!raw.includes("\n\n")) {
    throw new MalformedHelperInputError(
      `git credential helper stdin lacks the required terminating blank line`,
    );
  }

  const out = new Map<string, string>();
  for (const line of raw.split("\n")) {
    if (line === "") break;
    const eq = line.indexOf("=");
    if (eq <= 0) continue; // skip malformed key=value lines silently per the docs
    out.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return out;
}

function ok(text: string): ExecHandleResult {
  return { kind: "stdout", text, exit: 0 };
}
