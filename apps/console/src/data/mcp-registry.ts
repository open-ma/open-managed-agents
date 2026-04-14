/**
 * MCP Server Registry — known remote MCP servers that support OAuth via MCP spec.
 * Users search this list or enter a custom URL.
 * OAuth discovery is handled via .well-known/oauth-protected-resource.
 *
 * CLI tools (GitHub, GitLab, etc.) are NOT here — they don't support MCP OAuth
 * discovery or Dynamic Client Registration. Users add CLI tokens manually
 * via the "Add secret" flow.
 */

export interface McpRegistryEntry {
  id: string;
  name: string;
  url: string;
  icon?: string;
}

export const MCP_REGISTRY: McpRegistryEntry[] = [
  { id: "airtable", name: "Airtable", url: "https://mcp.airtable.com/mcp", icon: "https://airtable.com/favicon.ico" },
  { id: "amplitude", name: "Amplitude", url: "https://mcp.amplitude.com/mcp", icon: "https://amplitude.com/favicon.ico" },
  { id: "apollo", name: "Apollo.io", url: "https://mcp.apollo.io/mcp", icon: "https://apollo.io/favicon.ico" },
  { id: "asana", name: "Asana", url: "https://mcp.asana.com/v2/mcp", icon: "https://asana.com/favicon.ico" },
  { id: "atlassian", name: "Atlassian Rovo", url: "https://mcp.atlassian.com/v1/mcp", icon: "https://atlassian.com/favicon.ico" },
  { id: "clickup", name: "ClickUp", url: "https://mcp.clickup.com/mcp", icon: "https://clickup.com/favicon.ico" },
  { id: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", icon: "https://github.com/favicon.ico" },
  { id: "intercom", name: "Intercom", url: "https://mcp.intercom.com/mcp", icon: "https://intercom.com/favicon.ico" },
  { id: "linear", name: "Linear", url: "https://mcp.linear.app/mcp", icon: "https://linear.app/favicon.ico" },
  { id: "notion", name: "Notion", url: "https://mcp.notion.com/mcp", icon: "https://notion.so/favicon.ico" },
  { id: "sentry", name: "Sentry", url: "https://mcp.sentry.dev/mcp", icon: "https://sentry.io/favicon.ico" },
  { id: "slack", name: "Slack", url: "https://mcp.slack.com/mcp", icon: "https://slack.com/favicon.ico" },
];
