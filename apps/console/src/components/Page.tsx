import type { ReactNode } from "react";

/**
 * Standard scrollable page wrapper. Replaces the repeated
 * `flex-1 overflow-y-auto px-4 py-4 md:p-8 lg:p-10` (and the desktop-only
 * `p-8 lg:p-10` variant some pages drifted to). Mobile gets sane padding,
 * desktop gets the fuller breathing room — single place to tune.
 *
 * Use for content/detail/list pages. Pages with custom chrome (chat-style
 * shells like SessionDetail) keep their own layout.
 */
interface PageProps {
  children: ReactNode;
  className?: string;
}

export function Page({ children, className = "" }: PageProps) {
  return (
    <div className={`flex-1 overflow-y-auto px-4 py-4 md:p-8 lg:p-10 ${className}`.trim()}>
      {children}
    </div>
  );
}
