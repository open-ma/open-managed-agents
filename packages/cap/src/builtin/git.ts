// git — git credential helper.
//
// Configured via `git config credential.helper cap` (or
// `credential.https://github.com.helper cap` to scope per-host). git
// invokes `git-credential-cap` with one of {get, store, erase} and pipes
// `key=value\n…\n\n` blocks both directions.
//
// `endpoints` is the canonical https remote host. For multi-host setups
// (github.com, gitlab.com, internal Gitea, …), L4 should compose multiple
// per-host registry entries or extend this spec.

import type { CapSpec } from "../types";

export const gitSpec: CapSpec = {
  cli_id: "git",
  description: "git credential helper (https remotes)",
  endpoints: ["github.com"],
  inject_mode: "exec_helper",
  exec: { protocol: "git_credential_helper" },
  bootstrap: {
    files: [
      {
        // L4 typically invokes `git config --global credential.helper cap`
        // instead of writing this file directly; included as a reference.
        path: ".gitconfig.cap",
        content: "[credential]\n\thelper = cap\n",
      },
    ],
  },
};
