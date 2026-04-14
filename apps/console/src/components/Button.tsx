import { forwardRef, type ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
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
  ({ variant = "primary", size = "md", className = "", disabled, ...props }, ref) => (
    <button
      ref={ref}
      disabled={disabled}
      className={[
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors",
        "disabled:opacity-50 disabled:pointer-events-none disabled:cursor-not-allowed",
        variantClasses[variant],
        sizeClasses[size],
        className,
      ].join(" ")}
      {...props}
    />
  ),
);

Button.displayName = "Button";
