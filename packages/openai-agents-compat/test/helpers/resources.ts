import { AgentsApplicationService, CredentialsApplicationService, EnvironmentsApplicationService, FilesApplicationService, VaultsApplicationService } from "../../../managed-agents-application/src/index";
import { MemoryAgentStore } from "../../../agent-store-memory/src/index";
import { MemoryVaultStore } from "../../../vault-store-memory/src/index";
import { MemoryCredentialStore } from "../../../credential-store-memory/src/index";
import { MemoryEnvironmentStore } from "../../../environment-store-memory/src/index";
import { createResourcesHandler } from "../../src/resources";
import type { OpenAIAgentsOperationRequest } from "../../../openai-agents-api/src/index";
import type { ResourceRuntimeFiles } from "../../src/resource-types";
import { MemoryFileStore } from "../../../file-store-memory/src/index";
import type { FileContentStore } from "../../../file-content-store/src/index";

export function resourcesFixture(runtime?: ResourceRuntimeFiles) {
  let sequence = 0;
  const shared = { workspaceId: "workspace_a", clock: { now: () => new Date(1_800_000_000_000 + sequence++ * 1000) } };
  const agentStore = new MemoryAgentStore();
  const vaultStore = new MemoryVaultStore();
  const credentialStore = new MemoryCredentialStore();
  const environmentStore = new MemoryEnvironmentStore();
  const agents = new AgentsApplicationService({ ...shared, store: agentStore, ids: { nextAgentId: () => `agent_${sequence++}` } });
  const vaults = new VaultsApplicationService({ ...shared, store: vaultStore, ids: { nextVaultId: () => `vault_${sequence++}` } });
  const credentials = new CredentialsApplicationService({ ...shared, store: credentialStore, vaults: { find: async input => (await vaultStore.find(input))?.vault ?? null }, ids: { nextCredentialId: () => `credential_${sequence++}` }, validation: { validate: async () => ({ hasRefreshToken: false, mcpProbe: null, refresh: null, status: "indeterminate" }) } });
  const environments = new EnvironmentsApplicationService({ ...shared, store: environmentStore, ids: { nextEnvironmentId: () => `environment_${sequence++}` } });
  const blobs = new Map<string, Uint8Array>();
  const content: FileContentStore = {
    async get({ workspaceId, fileId }) { return blobs.get(`${workspaceId}:${fileId}`)?.slice() ?? null; },
    async put({ workspaceId, fileId, content }) { blobs.set(`${workspaceId}:${fileId}`, content.slice()); },
    async delete({ workspaceId, fileId }) { blobs.delete(`${workspaceId}:${fileId}`); },
  };
  const files = new FilesApplicationService({ ...shared, store: new MemoryFileStore(), content, ids: { nextFileId: () => `file_${sequence++}` } });
  const key = crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const secrets = {
    async seal(plaintext: string) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key, new TextEncoder().encode(plaintext));
      return `${Buffer.from(iv).toString("base64")}.${Buffer.from(encrypted).toString("base64")}`;
    },
    async open(ciphertext: string) {
      const [iv, data] = ciphertext.split(".");
      return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(iv!, "base64") }, await key, Buffer.from(data!, "base64")));
    },
  };
  const handler = createResourcesHandler({ agents, vaults, credentials, environments, files, secrets, runtime });
  async function run(operation: OpenAIAgentsOperationRequest["operation"], body: Record<string, unknown> = {}, params: Record<string, string> = {}, query: Record<string, string | number | boolean | string[]> = {}) {
    return (await handler({ operation, body, params, query, headers: new Headers(), signal: new AbortController().signal })).body as Record<string, any>;
  }
  return { run, handler, agents, vaults, credentials, environments, files, secrets, agentStore, credentialStore, environmentStore };
}
