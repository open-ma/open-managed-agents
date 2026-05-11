// kubectl exec credential plugin (client.authentication.k8s.io/v1).
//
// Spec reference: https://kubernetes.io/docs/reference/access-authn-authz/authentication/#client-go-credential-plugins
//
// Wire shape on stdout:
//   {
//     "apiVersion": "client.authentication.k8s.io/v1",
//     "kind": "ExecCredential",
//     "status": {
//       "token": "...",
//       "expirationTimestamp": "2026-05-09T12:30:45Z"   // optional
//     }
//   }
//
// On no credential available: exit non-zero with stderr message. kubectl
// surfaces this to the user; an empty/null ExecCredential would loop the
// API server through repeated re-auth attempts.

import type { ExecHandleResult, ExecHelperInput } from "../types";
import type { Clock, ResolvedToken } from "../ports";

const API_VERSION = "client.authentication.k8s.io/v1";

export function applyKubectlExec(
  _cli_id: string,
  token: ResolvedToken | null,
  _input: ExecHelperInput,
  _clock: Clock,
): ExecHandleResult {
  if (token === null) {
    return {
      kind: "error",
      message: "no credential available for this principal",
      exit: 1,
    };
  }

  const status: { token: string; expirationTimestamp?: string } = {
    token: token.token,
  };
  if (token.expires_at !== undefined) {
    status.expirationTimestamp = new Date(token.expires_at).toISOString();
  }

  return {
    kind: "stdout",
    text: JSON.stringify({
      apiVersion: API_VERSION,
      kind: "ExecCredential",
      status,
    }),
    exit: 0,
  };
}
