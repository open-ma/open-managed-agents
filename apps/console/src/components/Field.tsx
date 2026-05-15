import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  type ReactElement,
  type ReactNode,
} from "react";

interface FieldProps {
  /** Visible label text. Rendered as `<label htmlFor>`. */
  label?: ReactNode;
  /** Helper text below the input. Wired up via `aria-describedby` on the
   *  child so screen readers announce it after the input's name. */
  hint?: ReactNode;
  /** Visible inline error. When set, takes precedence over `hint` and
   *  the child gains `aria-invalid="true"`. */
  error?: ReactNode;
  /** Optional class on the wrapper. */
  className?: string;
  /** Single form control: input / textarea / select / Combobox / Select.
   *  The control is cloned with `id`, `aria-describedby`, and
   *  `aria-invalid` props so callers don't have to thread them. */
  children: ReactNode;
}

/**
 * Form-field wrapper that programmatically associates a label with its
 * input via `htmlFor`/`id`. Replaces the 6 in-file reimplementations
 * across console pages — most of which forgot the `htmlFor`/`id` pair
 * and silently shipped orphan labels (clicking the label didn't focus
 * the input; SR users couldn't pair them).
 *
 * Usage:
 *   <Field label="Workspace name" hint="Letters, numbers, dashes only.">
 *     <input value={name} onChange={...} className={inputCls} />
 *   </Field>
 *
 * The cloning approach lets callsites use any form-control element
 * without a pre-defined wrapper. The control's existing `id`, if any,
 * wins over the generated one, so callers can override.
 */
export function Field({ label, hint, error, className, children }: FieldProps) {
  const generatedId = useId();
  const child = Children.only(children) as ReactElement<{
    id?: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean;
  }>;

  const inputId = (isValidElement(child) && child.props.id) || generatedId;
  const hintId = hint || error ? `${inputId}-hint` : undefined;

  const childWithProps = isValidElement(child)
    ? cloneElement(child, {
        id: inputId,
        "aria-describedby": hintId ?? child.props["aria-describedby"],
        "aria-invalid": error ? true : child.props["aria-invalid"],
      })
    : child;

  if (!label && !hint && !error) return <>{childWithProps}</>;

  return (
    <div className={className}>
      {label && (
        <label
          htmlFor={inputId}
          className="block text-[13px] font-medium text-fg mb-1.5"
        >
          {label}
        </label>
      )}
      {childWithProps}
      {error ? (
        <p id={hintId} className="mt-1 text-[12px] text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="mt-1 text-[12px] text-fg-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
