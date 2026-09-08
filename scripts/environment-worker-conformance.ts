import Anthropic from "@anthropic-ai/sdk";
import {
  runExternalEnvironmentWorkerConformance,
  type ExternalEnvironmentWork,
} from "../packages/managed-runtime-host/src/index.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function sessionsToken(secret: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(secret, "base64url").toString("utf8"));
  } catch {
    throw new Error("Work secret is not the official base64url JSON envelope");
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || !("sessions_token" in parsed)
    || typeof parsed.sessions_token !== "string"
    || parsed.sessions_token === ""
  ) {
    throw new Error("Work secret does not contain sessions_token");
  }
  return parsed.sessions_token;
}

const baseURL = required("OMA_BASE_URL").replace(/\/+$/g, "");
const environmentId = required("OMA_ENVIRONMENT_ID");
const environmentKey = required("OMA_ENVIRONMENT_KEY");
const expectedWorkId = required("OMA_CONFORMANCE_WORK_ID");
const client = new Anthropic({
  apiKey: null,
  authToken: environmentKey,
  baseURL,
  maxRetries: 0,
});

const report = await runExternalEnvironmentWorkerConformance({
  client,
  environmentId,
  environmentKey,
  expectedWorkId,
  workerId: process.env.OMA_CONFORMANCE_WORKER_ID ?? `conformance-${process.pid}`,
  claimClientFor(work: ExternalEnvironmentWork) {
    return new Anthropic({
      apiKey: null,
      authToken: sessionsToken(work.secret!),
      baseURL,
      maxRetries: 0,
    });
  },
  async verifyWorkSecret(work: ExternalEnvironmentWork) {
    const token = sessionsToken(work.secret!);
    const sessionClient = new Anthropic({
      apiKey: null,
      authToken: token,
      baseURL,
      maxRetries: 0,
    });
    const session = await sessionClient.beta.sessions.retrieve(work.data.id);
    if (session.id !== work.data.id || session.environment_id !== environmentId) {
      throw new Error("Per-work sessions_token resolved the wrong Session scope");
    }
    const escaped = await fetch(`${baseURL}/v1/agents`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (escaped.status !== 401 && escaped.status !== 403) {
      throw new Error(`Per-work sessions_token escaped Session scope (${escaped.status})`);
    }
  },
});

process.stdout.write(`${JSON.stringify({ ok: true, ...report })}\n`);
