import { nanoid } from "nanoid";

export const generateId = () => nanoid(16);
export const generateAgentId = () => `agent_${nanoid(16)}`;
export const generateEnvId = () => `env_${nanoid(16)}`;
export const generateSessionId = () => `sess_${nanoid(16)}`;
export const generateVaultId = () => `vlt_${nanoid(16)}`;
export const generateCredentialId = () => `cred_${nanoid(16)}`;
export const generateMemoryStoreId = () => `memstore_${nanoid(16)}`;
export const generateMemoryId = () => `mem_${nanoid(16)}`;
export const generateMemoryVersionId = () => `memver_${nanoid(16)}`;
export const generateFileId = () => `file_${nanoid(16)}`;
export const generateResourceId = () => `sesrsc_${nanoid(16)}`;
export const generateEventId = () => `evt_${nanoid(16)}`;
