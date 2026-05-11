// kubectl — Kubernetes client, via exec credential plugin.
//
// kubectl reads a kubeconfig with a `users[].user.exec` block pointing at
// a binary; the binary is invoked, prints an `ExecCredential` JSON
// envelope to stdout, and kubectl uses the embedded token to authenticate
// to the API server.
//
// The L4 adapter installs a small wrapper binary at the path the
// kubeconfig references; that binary calls `handleExec("kubectl", …)` and
// writes the result to stdout. CAP is invoked once per API server
// re-auth; the resolver decides cache vs refresh.
//
// `endpoints` here is symbolic — kubectl never makes outbound HTTPS to a
// "kubectl host" of its own, so the value is not used by handleHttp. It
// exists only to satisfy the registry's "endpoints are non-empty"
// invariant; a future `inject_mode_endpoints_optional` flag could remove
// the placeholder.

import type { CapSpec } from "../types";

export const kubectlSpec: CapSpec = {
  cli_id: "kubectl",
  description: "kubectl exec credential plugin (client.authentication.k8s.io/v1)",
  endpoints: ["kubectl.cap.local"],
  inject_mode: "exec_helper",
  exec: { protocol: "kubectl_exec_credential_v1" },
  bootstrap: {
    files: [
      // L4 stitches a real kubeconfig that points users[].user.exec at the
      // installed cap binary. This file is illustrative — the L4 adapter
      // owns the actual install path and substitutes ${exec_command}.
      {
        path: ".kube/config.cap",
        content:
          "apiVersion: v1\nkind: Config\nusers:\n- name: cap\n  user:\n    exec:\n      apiVersion: client.authentication.k8s.io/v1\n      command: cap-helper\n      args: [\"kubectl\"]\n",
      },
    ],
  },
};
