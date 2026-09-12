import type { SessionResource } from "@open-managed-agents/domain/sessions";

export interface StoredSessionResources {
  resources: SessionResource[];
  revision: number;
}

export type SessionResourceSecretChange =
  | {
      type: "store_github_token";
      resourceId: string;
      authorizationToken: string;
    }
  | {
      type: "delete_github_token";
      resourceId: string;
    };

export interface FindCurrentSessionResources {
  workspaceId: string;
  sessionId: string;
}

export interface ReplaceCurrentSessionResources
  extends FindCurrentSessionResources {
  expectedRevision: number;
  resources: SessionResource[];
  updatedAt: string;
  secretChanges: SessionResourceSecretChange[];
}

export type ReplaceCurrentSessionResourcesResult =
  | { type: "replaced"; record: StoredSessionResources }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

/**
 * Resource projection of the Session aggregate.
 *
 * Implementations must use the same Session revision and persist public
 * resources plus secret changes atomically.
 */
export interface SessionResourceStore {
  findCurrent(
    input: FindCurrentSessionResources,
  ): Promise<StoredSessionResources | null>;
  replaceCurrent(
    input: ReplaceCurrentSessionResources,
  ): Promise<ReplaceCurrentSessionResourcesResult>;
}

/** Read-side capability for materializing private repository resources.
 * Implementations must scope every lookup to the owning workspace and
 * Session; the plaintext is returned only to the runtime preparing that
 * Session and is never added to the public Session aggregate. */
export interface SessionResourceSecretSource {
  findGithubToken(input: {
    workspaceId: string;
    sessionId: string;
    resourceId: string;
  }): Promise<string | null>;
}
