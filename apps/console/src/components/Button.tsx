import { forwardRef, type ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
  /** When true, disables the button and renders a spinner; pair with
   *  useAsyncAction so a fast double-click can't fire the handler twice
   *  (the bug that made Create-Key produce duplicate records). */
  loading?: boolean;
  /** Replaces children while loading. Defaults to children unchanged. */
  loadingLabel?: string;
}

const variantClasses: Record<NonNullable<ButtonProps["variant"]>, string> = {
  primary:
    "bg-brand text-brand-fg hover:bg-brand-hover focus-visible:ring-2 focus-visible:ring-brand",
  secondary:
    "border border-border text-fg hover:bg-bg-surface focus-visible:ring-2 focus-visible:ring-brand",
  danger:
    "border border-danger/30 text-danger hover:bg-danger-subtle focus-visible:ring-2 focus-visible:ring-danger",
  ghost:
    "text-fg-muted hover:text-fg hover:bg-bg-surface focus-visible:ring-2 focus-visible:ring-brand",
};

const sizeClasses: Record<NonNullable<ButtonProps["size"]>, string> = {
  sm: "px-3 py-1 text-xs",
  md: "px-4 py-2 text-sm",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", className = "", disabled, loading, loadingLabel, children, ...props }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={[
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors",
        "disabled:opacity-50 disabled:pointer-events-none disabled:cursor-not-allowed",
        variantClasses[variant],
        sizeClasses[size],
        className,
      ].join(" ")}
      {...props}
    >
      {loading && (
        <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <circle cx="12" cy="12" r="9" opacity="0.25" />
          <path d="M21 12a9 9 0 0 1-9 9" />
        </svg>
      )}
      {loading && loadingLabel ? loadingLabel : children}
    </button>
  ),
);

Button.displayName = "Button";
