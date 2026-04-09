declare module "@cloudflare/sandbox" {
  import { Container } from "@cloudflare/containers";

  interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    success: boolean;
  }

  interface ReadFileResult {
    content: string;
  }

  interface BackupHandle {
    id: string;
    dir: string;
    name?: string;
  }

  interface SandboxInstance {
    exec(command: string, options?: { timeout?: number }): Promise<ExecResult>;
    readFile(path: string): Promise<ReadFileResult>;
    writeFile(path: string, content: string): Promise<void>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    execStream(command: string): Promise<ReadableStream>;
    mountBucket(
      bucketName: string,
      mountPath: string,
      options?: {
        endpoint?: string;
        localBucket?: boolean;
        readOnly?: boolean;
        prefix?: string;
        credentials?: { accessKeyId: string; secretAccessKey: string };
      }
    ): Promise<void>;
    unmountBucket(mountPath: string): Promise<void>;
    createBackup(options: {
      dir: string;
      name?: string;
      ttl?: number;
      useGitignore?: boolean;
    }): Promise<BackupHandle>;
    restoreBackup(handle: BackupHandle): Promise<void>;
  }

  export class Sandbox extends Container {}

  export function getSandbox(
    binding: DurableObjectNamespace,
    id: string
  ): SandboxInstance;

  export function proxyToSandbox(
    binding: DurableObjectNamespace,
    id: string,
    request: Request
  ): Promise<Response>;
}
