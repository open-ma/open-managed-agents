// Console plugin registry — extension point for hosted-only UI.
//
// Self-host (OSS-only) installs see this file's default empty array
// and render zero extra routes / nav items. Hosted deployments
// overlay-replace this file at build time (openma-hosted's
// .github/workflows/deploy*.yml "Apply hosted overlay" step) with
// one that imports + registers plugins from `hosted/console-plugins/*`.
//
// Today's hosted plugins:
//   - Billing (Polar checkout / balance / subscription)
//
// The plugin shape mirrors the Layout NavGroup / NavItem types
// deliberately — they're duplicated here instead of imported from
// Layout.tsx so plugin code never has to peek at the rest of the app.
// Any drift between Layout's types and this file's would be caught by
// tsc at the spread-into-navGroups call site (Layout.tsx).
//
// Routes: passed directly to react-router; the path is mounted under
// the authenticated <Layout /> wrapper so plugin pages share the
// sidebar / header / theme. Use absolute paths.
//
// Plugin pages are responsible for their own data fetching — they
// don't reach into OSS app state. A hosted billing page typically
// hits a separate hosted worker domain (billing.openma.dev) with the
// session cookie, no OSS API surface needed.

import type { ReactNode, ComponentType } from "react";

export interface PluginNavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
}

export interface PluginNavGroup {
  label: string;
  items: PluginNavItem[];
}

export interface PluginRoute {
  /** Path under the Layout-wrapped routes group. Absolute, no leading slash. */
  path: string;
  /** React element to render. Caller wraps in <Route>. */
  element: ReactNode;
}

export interface ConsolePlugin {
  /** Stable id — used only for diagnostics, not for routing. */
  id: string;
  /** Routes this plugin contributes. Mounted under <Layout />. */
  routes?: PluginRoute[];
  /** Nav groups appended to the sidebar after the built-in groups. */
  navGroups?: PluginNavGroup[];
}

export const consolePlugins: ConsolePlugin[] = [];
