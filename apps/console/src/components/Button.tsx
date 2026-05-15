import { forwardRef, type ButtonHTMLAttributes } from "react";
import { BrandLoader } from "./BrandLoader";

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
    "bg-brand text-brand-fg hover:bg-brand-hover hover:shadow-[var(--shadow-sm)] focus-visible:ring-2 focus-visible:ring-brand",
  secondary:
    "border border-border text-fg hover:bg-bg-surface hover:border-border-strong focus-visible:ring-2 focus-visible:ring-brand",
  danger:
    "border border-danger/30 text-danger hover:bg-danger-subtle hover:border-danger/50 focus-visible:ring-2 focus-visible:ring-danger",
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
        // Motion: properties scoped to colors + transform + shadow so layout
        // doesn't get animated. Spring ease + 100ms duration makes hover
        // feel immediate without snapping.
        "inline-flex items-center justify-center gap-2 rounded-md font-medium",
        "transition-[background-color,border-color,color,box-shadow,transform]",
        "duration-[var(--dur-quick)] ease-[var(--ease-soft)]",
        // Press feedback — subtle scale + shadow tuck. Disabled state
        // disables the press transform too via pointer-events-none.
        "active:scale-[0.97] active:duration-75",
        "disabled:opacity-50 disabled:pointer-events-none disabled:cursor-not-allowed",
        variantClasses[variant],
        sizeClasses[size],
        className,
      ].join(" ")}
      {...props}
    >
      {loading && <BrandLoader size="sm" label="Loading" className="!text-current" />}
      {loading && loadingLabel ? loadingLabel : children}
    </button>
  ),
);

Button.displayName = "Button";
