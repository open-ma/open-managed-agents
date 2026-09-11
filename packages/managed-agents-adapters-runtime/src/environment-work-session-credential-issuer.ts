import type {
  EnvironmentWorkSessionCredentialIssuerPort,
  IssueEnvironmentWorkSessionCredential,
  IssueEnvironmentWorkSessionCredentialResult,
} from "@open-managed-agents/managed-agents-application";

export interface OpaqueEnvironmentWorkSessionCredentialIssuerDependencies {
  nextToken(): string;
  apiBaseUrl?: string;
}

export class OpaqueEnvironmentWorkSessionCredentialIssuer
  implements EnvironmentWorkSessionCredentialIssuerPort
{
  constructor(
    private readonly dependencies: OpaqueEnvironmentWorkSessionCredentialIssuerDependencies,
  ) {}

  async issue(
    _input: IssueEnvironmentWorkSessionCredential,
  ): Promise<IssueEnvironmentWorkSessionCredentialResult> {
    const token = this.dependencies.nextToken();
    if (token.length === 0) {
      return { type: "rejected", message: "Session credential token is empty" };
    }
    return {
      type: "issued",
      secret: {
        sessionsToken: token.startsWith("sk-ant-req-")
          ? token
          : `sk-ant-req-${token}`,
        ...(this.dependencies.apiBaseUrl !== undefined && {
          apiBaseUrl: this.dependencies.apiBaseUrl,
        }),
      },
    };
  }

  async bindToClaim(
    input: {
      secret: { sessionsToken: string; apiBaseUrl?: string };
      claimedAt: string;
      generation: number;
    },
  ) {
    const token = this.dependencies.nextToken();
    if (token.length === 0) {
      throw new Error("Session credential token is empty");
    }
    return {
      secret: {
        ...input.secret,
        sessionsToken: token.startsWith("sk-ant-req-")
          ? token
          : `sk-ant-req-${token}`,
      },
    };
  }
}
