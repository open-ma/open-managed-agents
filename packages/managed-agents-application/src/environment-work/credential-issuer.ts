import type { Environment } from "../domain/environment";
import type { EnvironmentWorkSecret } from "@open-managed-agents/domain/environment-work";
import type { Session } from "../domain/session";

export interface IssueEnvironmentWorkSessionCredential {
  workspaceId: string;
  workId: string;
  environment: Environment;
  session: Session;
}

export type IssueEnvironmentWorkSessionCredentialResult =
  | { type: "issued"; secret: EnvironmentWorkSecret }
  | { type: "rejected"; message: string };

export interface BindEnvironmentWorkSessionCredentialToClaim {
  secret: EnvironmentWorkSecret;
  claimedAt: string;
  generation: number;
}

export interface BoundEnvironmentWorkSessionCredential {
  secret: EnvironmentWorkSecret;
}

export interface EnvironmentWorkSessionCredentialIssuerPort {
  issue(
    input: IssueEnvironmentWorkSessionCredential,
  ): Promise<IssueEnvironmentWorkSessionCredentialResult>;
  /** Rotate the bearer after every queue claim/reclaim. */
  bindToClaim(
    input: BindEnvironmentWorkSessionCredentialToClaim,
  ): Promise<BoundEnvironmentWorkSessionCredential>;
}
