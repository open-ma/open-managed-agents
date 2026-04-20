// Minimal Linear GraphQL client built on the HttpClient port. Hand-rolled
// queries — no codegen for now since the surface is small. Add codegen if we
// add many more queries.

import type { HttpClient } from "@open-managed-agents/integrations-core";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

export interface ViewerInfo {
  /** Linear user id of the App's bot user. */
  id: string;
  name: string;
}

export interface OrganizationInfo {
  /** Linear workspace id. */
  id: string;
  name: string;
  urlKey: string;
}

export class LinearGraphQLClient {
  constructor(private readonly http: HttpClient) {}

  /**
   * Fetch viewer + organization with a single round trip. Used after OAuth to
   * discover the bot's user id and the workspace's id/name.
   */
  async fetchViewerAndOrg(
    accessToken: string,
  ): Promise<{ viewer: ViewerInfo; organization: OrganizationInfo }> {
    const data = await this.query<{
      viewer: ViewerInfo;
      organization: OrganizationInfo;
    }>(
      accessToken,
      `query ViewerAndOrg {
         viewer { id name }
         organization { id name urlKey }
       }`,
    );
    return data;
  }

  /**
   * Run a GraphQL operation. Throws on transport errors; throws on GraphQL
   * `errors` array. Callers should treat all throws as "investigate me".
   */
  async query<T>(
    accessToken: string,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const res = await this.http.fetch({
      method: "POST",
      url: LINEAR_GRAPHQL_URL,
      headers: {
        "content-type": "application/json",
        authorization: accessToken.startsWith("Bearer ")
          ? accessToken
          : `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new LinearGraphQLError(
        `Linear GraphQL HTTP ${res.status}: ${res.body.slice(0, 500)}`,
        res.status,
      );
    }
    let parsed: { data?: T; errors?: Array<{ message: string }> };
    try {
      parsed = JSON.parse(res.body) as typeof parsed;
    } catch {
      throw new LinearGraphQLError(
        `Linear GraphQL: response is not JSON: ${res.body.slice(0, 500)}`,
        res.status,
      );
    }
    if (parsed.errors && parsed.errors.length > 0) {
      throw new LinearGraphQLError(
        `Linear GraphQL errors: ${parsed.errors.map((e) => e.message).join(", ")}`,
        res.status,
      );
    }
    if (!parsed.data) {
      throw new LinearGraphQLError("Linear GraphQL: empty data field", res.status);
    }
    return parsed.data;
  }
}

export class LinearGraphQLError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = "LinearGraphQLError";
  }
}
