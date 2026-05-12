// docker — Docker / OCI registry client, via credential helper.
//
// Docker reads ~/.docker/config.json for `credsStore` or per-registry
// `credHelpers` mapping a registry hostname to a helper binary name. The
// helper is invoked as `docker-credential-<name>` with one of
// {get, store, erase, list} and pipes data via stdin/stdout.
//
// L4 installs `docker-credential-cap` on the PATH and writes
// ~/.docker/config.json so it's used for the registries CAP knows about.
//
// `endpoints` here is the registry hostname users will type into
// `docker login`. It's the canonical Docker Hub host; private registries
// would extend the spec.

import type { CapSpec } from "../types";

export const dockerSpec: CapSpec = {
  cli_id: "docker",
  description: "Docker registry credential helper",
  endpoints: ["index.docker.io"],
  inject_mode: "exec_helper",
  exec: { protocol: "docker_credential_helper" },
  bootstrap: {
    files: [
      {
        // L4's responsibility to merge into the user's existing config.
        // This is a starter — it tells docker to use the cap helper for
        // index.docker.io specifically.
        path: ".docker/config.json",
        content: JSON.stringify(
          {
            credHelpers: { "index.docker.io": "cap" },
          },
          null,
          2,
        ),
      },
    ],
  },
};
