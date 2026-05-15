/**
 * Brand mark — the JetBrains-Mono `[horse]` logo. Single source of truth
 * so future logo swaps (or alt-text tweaks) are atomic.
 */
const SIZE_CLASSES = {
  sm: "h-8",
  md: "h-9",
  lg: "h-10",
} as const;

interface LogoProps {
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
}

export function Logo({ size = "sm", className = "" }: LogoProps) {
  return (
    <img
      src="/logo.svg"
      alt="openma"
      className={`${SIZE_CLASSES[size]} shrink-0 ${className}`.trim()}
    />
  );
}
