// aws — AWS CLI / SDK family, via Container Credentials emulation.
//
// CAP does NOT re-sign SigV4 — that path would require the proxy to fully
// reconstruct the canonical request, which is brittle (any header
// reordering, any body buffering, breaks the signature) and forces the
// real AWS keys into the proxy's address space.
//
// Instead we emulate the AWS Container Credentials provider: aws-sdk reads
// `AWS_CONTAINER_CREDENTIALS_FULL_URI`, fetches our local endpoint with
// `Authorization: <AWS_CONTAINER_AUTHORIZATION_TOKEN>`, and gets back
// temporary creds (AccessKeyId / SecretAccessKey / Token / Expiration).
// The SDK then signs upstream calls itself using those creds.
//
// Endpoints — `endpoints` here is the address the L4 adapter binds CAP's
// metadata server to. Default `169.254.170.2` matches AWS's canonical ECS
// metadata IP; L4 deployments without loopback-alias support should use
// a different host (e.g. a sidecar) and override this field at registry
// construction time.
//
// Reference:
//   https://docs.aws.amazon.com/sdkref/latest/guide/feature-container-credentials.html

import type { CapSpec } from "../types";

export const awsSpec: CapSpec = {
  cli_id: "aws",
  description: "AWS CLI / SDKs — Container Credentials provider emulation",
  endpoints: ["169.254.170.2"],
  inject_mode: "metadata_ep",
  metadata: {
    protocol: "aws_container_credentials_v1",
    path: "/cap/aws-creds",
    required_request_headers: { Authorization: "match_bootstrap_token" },
  },
  bootstrap: {
    env: {
      // L4 adapter MUST override this to the actual reachable URL when it
      // can't bind to 169.254.170.2 (e.g. CF Sandbox); the value here is
      // a starter template for the L4's substitution.
      AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.2/cap/aws-creds",
      AWS_CONTAINER_AUTHORIZATION_TOKEN: "__cap_managed__",
    },
  },
  endpoint_binding: {
    env_var: "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    value_template: "http://${cap_host}:${cap_port}/cap/aws-creds",
  },
};
