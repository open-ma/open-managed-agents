import { customAlphabet } from "nanoid";

// Lowercase + digits only — safe for Docker tags, wrangler names, URLs
const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 16);

export const generateId = () => nanoid();
export const generateAgentId = () => `agent-${nanoid()}`;
export const generateEnvId = () => `env-${nanoid()}`;
export const generateSessionId = () => `sess-${nanoid()}`;
export const generateVaultId = () => `vlt-${nanoid()}`;
export const generateCredentialId = () => `cred-${nanoid()}`;
export const generateMemoryStoreId = () => `memstore-${nanoid()}`;
export const generateMemoryId = () => `mem-${nanoid()}`;
export const generateMemoryVersionId = () => `memver-${nanoid()}`;
export const generateFileId = () => `file-${nanoid()}`;
export const generateResourceId = () => `sesrsc-${nanoid()}`;
export const generateEventId = () => `sevt-${nanoid()}`;
export const generateModelCardId = () => `mdl-${nanoid()}`;
