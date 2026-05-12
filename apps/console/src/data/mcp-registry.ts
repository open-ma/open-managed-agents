/**
 * MCP Server Registry — known remote MCP servers that support OAuth via MCP spec.
 * Users search this list or enter a custom URL.
 * OAuth discovery is handled via .well-known/oauth-protected-resource.
 *
 * CLI tools (GitHub, GitLab, etc.) are NOT here — they don't support MCP OAuth
 * discovery or Dynamic Client Registration. Users add CLI tokens manually
 * via the "Add secret" flow.
 *
 * Icon strategy: Google's favicon service. Per-domain `/favicon.ico` is
 * unreliable — many sites serve nothing at the apex (Intercom, Notion at
 * one point) or 30x to a CDN that breaks <img> requests. Google's
 * `s2/favicons` follows redirects, normalizes formats, and has edge
 * caching. One URL pattern, no per-brand guess work.
 */

export interface McpRegistryEntry {
  id: string;
  name: string;
  url: string;
  icon?: string;
}

function favicon(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
}

export const MCP_REGISTRY: McpRegistryEntry[] = [
  { id: "airtable", name: "Airtable", url: "https://mcp.airtable.com/mcp", icon: favicon("airtable.com") },
  { id: "amplitude", name: "Amplitude", url: "https://mcp.amplitude.com/mcp", icon: favicon("amplitude.com") },
  { id: "apollo", name: "Apollo.io", url: "https://mcp.apollo.io/mcp", icon: favicon("apollo.io") },
  { id: "asana", name: "Asana", url: "https://mcp.asana.com/v2/mcp", icon: favicon("asana.com") },
  { id: "atlassian", name: "Atlassian Rovo", url: "https://mcp.atlassian.com/v1/mcp", icon: favicon("atlassian.com") },
  { id: "clickup", name: "ClickUp", url: "https://mcp.clickup.com/mcp", icon: favicon("clickup.com") },
  { id: "feishu", name: "Feishu (飞书)", url: "https://mcp.feishu.cn/mcp", icon: favicon("feishu.cn") },
  { id: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", icon: favicon("github.com") },
  { id: "intercom", name: "Intercom", url: "https://mcp.intercom.com/mcp", icon: favicon("intercom.com") },
  { id: "linear", name: "Linear", url: "https://mcp.linear.app/mcp", icon: favicon("linear.app") },
  { id: "notion", name: "Notion", url: "https://mcp.notion.com/mcp", icon: favicon("notion.so") },
  { id: "sentry", name: "Sentry", url: "https://mcp.sentry.dev/mcp", icon: favicon("sentry.io") },
  { id: "slack", name: "Slack", url: "https://mcp.slack.com/mcp", icon: favicon("slack.com") },
];
