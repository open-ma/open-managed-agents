// metadata-aws mode — emits the AWS Container Credentials v1 response
// (the JSON envelope `aws-sdk` fetches from
// `AWS_CONTAINER_CREDENTIALS_FULL_URI`). Lets us issue temporary AWS
// credentials to the SDK without ever re-signing SigV4: the SDK takes
// these creds, then signs upstream API calls itself.
//
// Spec reference: https://docs.aws.amazon.com/sdkref/latest/guide/feature-container-credentials.html
//
// Validation: when spec.metadata.required_request_headers contains
// `"match_bootstrap_token"`, the mode compares the corresponding incoming
// header against `bootstrap.env[same-name-as-token-env-var]`. The bootstrap
// env var is whichever key in `bootstrap.env` shares its NAME with the
// incoming header it's matched against; for the canonical AWS spec that's
// `AWS_CONTAINER_AUTHORIZATION_TOKEN` matched against the incoming
// `Authorization` header.

import type { CapSpec, HttpHandleResult, HttpReqLike } from "../types";
import type { Clock, ResolvedToken } from "../ports";

const AWS_AUTH_TOKEN_ENV = "AWS_CONTAINER_AUTHORIZATION_TOKEN";

export function applyAwsMetadata(
  spec: CapSpec,
  token: ResolvedToken | null,
  req: HttpReqLike,
  _clock: Clock,
): HttpHandleResult {
  if (!validateRequestHeaders(spec, req)) {
    return jsonRespond(401, { code: "InvalidAuthorizationToken" });
  }

  if (token === null) {
    return jsonRespond(401, { code: "NoCredentialAvailable" });
  }

  if (token.expires_at === undefined) {
    return jsonRespond(500, {
      code: "MalformedCredential",
      message: "expires_at is required for metadata_ep mode",
    });
  }

  const accessKeyId = token.extras?.access_key_id;
  if (!accessKeyId) {
    return jsonRespond(500, {
      code: "MalformedCredential",
      message: "extras.access_key_id is required for AWS Container Credentials",
    });
  }

  const body: Record<string, string> = {
    AccessKeyId: accessKeyId,
    SecretAccessKey: token.token,
    Expiration: new Date(token.expires_at).toISOString(),
  };

  const sessionToken = token.extras?.session_token;
  if (sessionToken !== undefined) body.Token = sessionToken;

  return jsonRespond(200, body);
}

function validateRequestHeaders(spec: CapSpec, req: HttpReqLike): boolean {
  const required = spec.metadata?.required_request_headers;
  if (!required || Object.keys(required).length === 0) return true;

  for (const [headerName, expected] of Object.entries(required)) {
    const actual = headerValueCi(req.headers, headerName);
    if (expected === "match_bootstrap_token") {
      const bootstrapValue = spec.bootstrap?.env?.[bootstrapKeyForHeader(headerName)];
      // No bootstrap value to match against — request can never validate.
      if (bootstrapValue === undefined) return false;
      if (actual !== bootstrapValue) return false;
    } else {
      if (actual !== expected) return false;
    }
  }
  return true;
}

/**
 * Maps an incoming HTTP header name to the bootstrap env var it should be
 * compared against. AWS Container Credentials canonically uses the
 * Authorization header against AWS_CONTAINER_AUTHORIZATION_TOKEN. If a
 * future protocol re-uses match_bootstrap_token semantics with a different
 * mapping, extend the table here.
 */
function bootstrapKeyForHeader(headerName: string): string {
  if (headerName.toLowerCase() === "authorization") return AWS_AUTH_TOKEN_ENV;
  // Default convention: header NAME upper-snake — covers the
  // metadata-flavour-style cases without further plumbing.
  return headerName.toUpperCase().replace(/-/g, "_");
}

function headerValueCi(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function jsonRespond(status: number, body: unknown): HttpHandleResult {
  return {
    kind: "respond",
    res: {
      status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  };
}
