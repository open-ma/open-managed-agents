export type {
  ProcessHandle,
  SandboxDuplexProcess,
  SandboxDuplexProcessPort,
  SandboxDuplexProcessSpec,
  SandboxCheckpointHandle,
  SandboxCheckpointKind,
  SandboxCheckpointScope,
  SandboxPort,
  SandboxExecutor,
  SandboxFactory,
  SandboxFactoryContext,
  SandboxFactoryEnv,
  SandboxProviderPort,
  SandboxRuntimeCapabilities,
  SandboxRuntimeHandle,
  SandboxRuntimePort,
  SandboxRuntimeStatus,
  SandboxWorkspaceBackupPort,
  SandboxManagedWorkspaceLifecyclePort,
  SandboxSessionOutputMountPort,
} from "./ports";
export {
  supportsDuplexProcess,
  supportsManagedWorkspaceLifecycle,
  supportsSandboxRuntime,
  supportsSessionOutputMount,
  supportsWorkspaceBackup,
} from "./ports";
export {
  runWithSandboxLease,
  SandboxLeaseLostError,
  type RunWithSandboxLeaseOptions,
  type SandboxLeaseScheduler,
} from "./lease";

export {
  withSandboxExecutionGuard,
  SandboxExecutionFencedError,
  type SandboxExecutionGuard,
} from "./execution-guard";

export {
  DefaultSandboxOrchestrator,
  type SandboxOrchestrator,
  type SandboxCapabilities,
  type ProvisionInput,
  type OrchestratorMemoryMount,
  type OrchestratorBackupHandle,
  type WorkspaceBackupService,
  type DefaultSandboxOrchestratorDeps,
} from "./orchestrator";
