/**
 * Inline SVG icons used across the console. Stroke-based, currentColor
 * inheritance — drop in any text-color context, dark mode handles itself.
 *
 * Style + path data match the sidebar (Layout.tsx) icons so the same
 * resource family looks the same wherever it appears (sidebar nav, page
 * header, badges, etc.). Add new icons here rather than inlining at
 * call sites.
 */

const cls = "w-3.5 h-3.5";

function Icon({ d }: { d: string }) {
  return (
    <svg
      className={cls}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <path d={d} />
    </svg>
  );
}

// Paths copied from Layout.tsx so header badges line up with the sidebar
// nav icons for the same resource kind.
export function AgentIcon() {
  return <Icon d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />;
}

export function EnvIcon() {
  return <Icon d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />;
}

export function VaultIcon() {
  return <Icon d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />;
}

export function DurationIcon() {
  return <Icon d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />;
}

export function ClockIcon() {
  return <Icon d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />;
}

