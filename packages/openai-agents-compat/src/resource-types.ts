import type { AgentsApplicationPort } from "@open-managed-agents/managed-agents-application/ports/agents";
import type { VaultsApplicationPort } from "@open-managed-agents/managed-agents-application/ports/vaults";
import type { CredentialsApplicationPort } from "@open-managed-agents/managed-agents-application/ports/credentials";
import type { EnvironmentsApplicationPort } from "@open-managed-agents/managed-agents-application/ports/environments";
import type { FilesApplicationPort } from "@open-managed-agents/managed-agents-application/ports/files";
export type ResourceObject = Record<string, any>;

/** Same seal/open shape used by the existing session-resource secret adapters. */
export interface ResourceSecretSealer {
  seal(plaintext: string): Promise<string>;
  open(ciphertext: string): Promise<string>;
}

/** Provider boundary: these methods operate on the connected execution environment,
 * rather than maintaining an imitation filesystem in protocol state. */
export interface ResourceRuntimeFiles {
  getEnvironment(environmentId: string): Promise<ResourceObject | null>;
  writeFile(environmentId: string, path: string, content: Uint8Array): Promise<void>;
  listFiles(environmentId: string, path?: string): Promise<Array<{ path: string; size_bytes: number }>>;
}

export interface ResourceDependencies {
  agents: AgentsApplicationPort;
  vaults: VaultsApplicationPort;
  credentials: CredentialsApplicationPort;
  environments: EnvironmentsApplicationPort;
  files?: FilesApplicationPort;
  /** Template confidential fields are sealed before entering existing Environment metadata. */
  secrets: ResourceSecretSealer;
  runtime?: ResourceRuntimeFiles;
}
