import { inject } from "vitest";

export interface StorageIntegrationConfig {
  postgres: {
    agentsSql: string;
    sessionsSql: string;
    feishuSchema: string;
    betterAuth: string;
    eventFanout: string;
    queue: string;
    s3Memory: string;
    runtimeFence: string;
  };
  s3: {
    endpoint: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
    region: string;
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    storageIntegration: StorageIntegrationConfig;
  }
}

export function getStorageIntegrationConfig(): StorageIntegrationConfig {
  return inject("storageIntegration");
}
