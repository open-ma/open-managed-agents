import { useState, type InputHTMLAttributes, type ReactNode } from "react";

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
 * webhook secrets, anything sensitive. Renders masked by default with a
 * right-side eye toggle so the user can verify the paste landed in the
 * right field (Stripe / Vercel / GitHub PAT pattern). Always sets
 * `autoComplete="new-password"` (the only reliable way to disable
 * Chrome's saved-password autofill — `off` is ignored on type=password)
 * plus 1Password / LastPass opt-out attrs.
 *
 * Use this in any "paste a credential" UI — never `<input type="password">`
 * directly, otherwise the browser autofills the user's iCloud/Google
 * password into a place it doesn't belong, AND the user has to paste
 * blind into a row of dot-fields.
 */
export function SecretInput({
  className,
  label,
  hint,
  ...rest
}: CommonProps) {
  const [revealed, setRevealed] = useState(false);
  return (
    <Field label={label} hint={hint}>
      <div className="relative">
        <input
          type={revealed ? "text" : "password"}
          autoComplete="new-password"
          data-1p-ignore
          data-lpignore="true"
          className={`${className ?? baseClass} pr-10`}
          {...rest}
        />
        <button
          type="button"
          onClick={() => setRevealed((r) => !r)}
          className="absolute inset-y-0 right-0 px-2.5 flex items-center text-fg-subtle hover:text-fg-muted transition-colors"
          title={revealed ? "Hide" : "Show"}
          aria-label={revealed ? "Hide secret" : "Show secret"}
        >
          {revealed ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
    </Field>
  );
}

function EyeIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  );
}
