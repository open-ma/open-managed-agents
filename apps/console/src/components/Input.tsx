import type { InputHTMLAttributes, ReactNode } from "react";

/**
 * Default styling for text-ish inputs across the console. Kept here so
 * pages don't each invent their own border/padding/focus look.
 */
const baseClass =
  "w-full border border-border rounded-md px-3 py-2 text-[13px] bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle";

type CommonProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "className"
> & {
  className?: string;
  /** Wrap with a labelled <div> if provided. Saves callsites the
   *  boilerplate of label + helper-text composition. */
  label?: ReactNode;
  hint?: ReactNode;
};

function Field({ label, hint, children }: { label?: ReactNode; hint?: ReactNode; children: ReactNode }) {
  if (!label && !hint) return <>{children}</>;
  return (
    <div>
      {label && (
        <label className="block text-[13px] font-medium text-fg mb-1.5">{label}</label>
      )}
      {children}
      {hint && <p className="mt-1 text-[12px] text-fg-muted">{hint}</p>}
    </div>
  );
}

/**
 * Plain text input. Defaults `autoComplete="off"` to prevent the browser
 * from offering saved credentials in non-login contexts (persona names,
 * agent ids, paths…). Add a specific `autoComplete` token (e.g. "email"
 * or "username") at the call site if a real autofill is wanted.
 */
export function TextInput({
  className,
  label,
  hint,
  autoComplete,
  ...rest
}: CommonProps) {
  return (
    <Field label={label} hint={hint}>
      <input
        type="text"
        autoComplete={autoComplete ?? "off"}
        data-1p-ignore
        data-lpignore="true"
        className={className ?? baseClass}
        {...rest}
      />
    </Field>
  );
}

/**
 * Secret input — for API keys, tokens, signing secrets, client secrets,
 * webhook secrets, anything sensitive. Renders as type=password (so
 * shoulder-surfers don't see it) and ALWAYS sets `autoComplete="new-password"`,
 * which is the only reliable way to disable Chrome's saved-password
 * autofill (it ignores `off` on type=password). Plus 1Password / LastPass
 * opt-out attrs.
 *
 * Use this in any "paste a credential" UI — never `<input type="password">`
 * directly, otherwise the browser autofills the user's iCloud/Google
 * password into a place it doesn't belong.
 */
export function SecretInput({
  className,
  label,
  hint,
  ...rest
}: CommonProps) {
  return (
    <Field label={label} hint={hint}>
      <input
        type="password"
        autoComplete="new-password"
        data-1p-ignore
        data-lpignore="true"
        className={className ?? baseClass}
        {...rest}
      />
    </Field>
  );
}
