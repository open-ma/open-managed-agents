/**
 * Cloudflare API helpers for managing Worker script settings.
 * Used to dynamically add/remove service bindings when environments are created/deleted.
 */

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

interface ServiceBinding {
  type: "service";
  name: string;
  service: string;
}

interface ScriptSettings {
  bindings: Array<ServiceBinding | Record<string, unknown>>;
  [key: string]: unknown;
}

export async function getScriptSettings(
  accountId: string,
  scriptName: string,
  token: string,
): Promise<ScriptSettings> {
  const res = await fetch(
    `${CF_API_BASE}/accounts/${accountId}/workers/scripts/${scriptName}/settings`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to get script settings: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { result: ScriptSettings };
  return json.result;
}

export async function patchScriptSettings(
  accountId: string,
  scriptName: string,
  token: string,
  settings: Partial<ScriptSettings>,
): Promise<void> {
  const res = await fetch(
    `${CF_API_BASE}/accounts/${accountId}/workers/scripts/${scriptName}/settings`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(settings),
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to patch script settings: ${res.status} ${await res.text()}`);
  }
}

/**
 * Add a service binding to the main worker, pointing to a sandbox worker.
 */
export async function addServiceBinding(
  accountId: string,
  mainWorkerName: string,
  token: string,
  bindingName: string,
  targetWorkerName: string,
): Promise<void> {
  const settings = await getScriptSettings(accountId, mainWorkerName, token);
  const bindings = settings.bindings || [];

  // Remove existing binding with same name (if re-building)
  const filtered = bindings.filter((b) => b.name !== bindingName);
  filtered.push({
    type: "service",
    name: bindingName,
    service: targetWorkerName,
  });

  await patchScriptSettings(accountId, mainWorkerName, token, { bindings: filtered });
}

/**
 * Remove a service binding from the main worker.
 */
export async function removeServiceBinding(
  accountId: string,
  mainWorkerName: string,
  token: string,
  bindingName: string,
): Promise<void> {
  const settings = await getScriptSettings(accountId, mainWorkerName, token);
  const bindings = (settings.bindings || []).filter((b) => b.name !== bindingName);
  await patchScriptSettings(accountId, mainWorkerName, token, { bindings });
}

/**
 * Convert an environment ID to a safe binding name.
 * Must match the formula sessions.ts:getSandboxBinding uses to look up
 * `c.env[bindingName]` — that side reads `SANDBOX_${worker.replace(/-/g, "_")}`,
 * where worker = envIdToWorkerName(envId) = "sandbox-${envId}".
 * e.g. "env-abc123" → "SANDBOX_sandbox_env_abc123"
 */
export function envIdToBindingName(envId: string): string {
  return `SANDBOX_${envIdToWorkerName(envId).replace(/-/g, "_")}`;
}

/**
 * Convert an environment ID to a sandbox worker name.
 * e.g. "env-abc123" → "sandbox-env-abc123"
 */
export function envIdToWorkerName(envId: string): string {
  return `sandbox-${envId}`;
}
