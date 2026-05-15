/**
 * Brand-mark loader — `[ … ]` with three pulsing dots inside the
 * JetBrains Mono brackets. Reuses the brand identity (the openma logo
 * is the same `[ ]` shape) so loading states feel native to the
 * product instead of generic spinner-y.
 *
 * Three sizes:
 *   - sm  → 14px text, fits inside Button next to label
 *   - md  → 18px, default for inline "Loading X" or panel-level
 *   - lg  → 32px, EmptyState-style, page-level loading
 *
 * Each dot animates `opacity` 0.35 → 1.0 → 0.35 with a 200ms stagger,
 * so it reads as a wave moving left → right rather than three pulses
 * firing in unison. animate-pulse alone (uniform) feels artificial.
 */
const SIZE: Record<"sm" | "md" | "lg", { text: string; gap: string; weight: string }> = {
  sm: { text: "text-[12px]", gap: "gap-[1px]", weight: "font-medium" },
  md: { text: "text-[14px]", gap: "gap-[2px]", weight: "font-medium" },
  lg: { text: "text-[18px] leading-none", gap: "gap-[2px]", weight: "font-medium" },
};

interface BrandLoaderProps {
  size?: keyof typeof SIZE;
  /** Optional accessible label. Defaults to "Loading". */
  label?: string;
  className?: string;
}

export function BrandLoader({ size = "md", label = "Loading", className = "" }: BrandLoaderProps) {
  const s = SIZE[size];
  return (
    <span
      role="status"
      aria-label={label}
      className={`inline-flex items-center font-mono ${s.weight} text-brand select-none ${s.text} ${className}`.trim()}
    >
      <span aria-hidden="true">[</span>
      <span aria-hidden="true" className={`inline-flex items-center px-[0.4em] ${s.gap}`}>
        <span className="brand-loader-dot" style={{ animationDelay: "0ms" }}>·</span>
        <span className="brand-loader-dot" style={{ animationDelay: "200ms" }}>·</span>
        <span className="brand-loader-dot" style={{ animationDelay: "400ms" }}>·</span>
      </span>
      <span aria-hidden="true">]</span>
    </span>
  );
}
