import { describe, expect, it, vi } from "vitest";

import { resolveManagedGithubCredentials } from "../src/lib/github-creds";

describe("Managed Session GitHub credential routing", () => {
  it("reads the canonical Session resource and opens only its matching secret", async () => {
    const sessionSource = {
      find: vi.fn(async () => ({
        archivedAt: null,
        resources: [
          {
            id: "resource-repository",
            type: "github_repository" as const,
            url: "https://github.com/openma/private-certification.git",
          },
        ],
      })),
    };
    const secrets = {
      findGithubToken: vi.fn(async () => "github-token"),
    };

    await expect(resolveManagedGithubCredentials(
      sessionSource,
      secrets,
      {
        workspaceId: "workspace-1",
        sessionId: "session-1",
        hostname: "github.com",
        pathname: "/openma/private-certification.git/info/refs",
      },
    )).resolves.toEqual({
      scheme: "Basic",
      token: "github-token",
      slug: "openma/private-certification",
    });
    expect(secrets.findGithubToken).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      resourceId: "resource-repository",
    });
  });
});
