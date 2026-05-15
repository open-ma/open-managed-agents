import * as RadixSelect from "@radix-ui/react-select";
import { forwardRef, type ReactNode } from "react";

/**
 * Styled wrapper around Radix Select. Mirrors the look of TextInput
 * (border-border, focus:border-brand) and the popover style of Modal
 * (bg-bg, shadow-xl, fade transition). Use this anywhere you'd otherwise
 * reach for native `<select>`.
 *
 * Native `<select>` is intentionally avoided because:
 *   1. It can't be styled to match the design tokens (bg/fg/border) on
 *      every platform — Safari/macOS in particular shows the system widget.
 *   2. No type-to-search inside large option lists.
 *   3. No accessible labelling for groups.
 *
 * Radix Select gives us all of the above for ~30KB and matches the
 * Anthropic Console picker behavior (popover, keyboard ↑↓Enter, ARIA
 * combobox roles).
 *
 * Usage:
 *
 *   <Select value={form.agent} onValueChange={(v) => setForm({...form, agent: v})}
 *           placeholder="Select an agent...">
 *     {agents.map(a => (
 *       <SelectOption key={a.id} value={a.id}>{a.name}</SelectOption>
 *     ))}
 *   </Select>
 */

interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  /** When true, renders disabled. */
  disabled?: boolean;
  /** Optional name; emitted as the underlying form input. */
  name?: string;
  /** Override the trigger className. Default mirrors TextInput. */
  className?: string;
  /** Limit the popover height; longer lists scroll. Default 320px. */
  maxHeight?: string;
  children: ReactNode;
}

const triggerClass =
  "w-full inline-flex items-center justify-between gap-2 border border-border rounded-md px-3 py-2 text-[13px] bg-bg text-fg " +
  "outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] " +
  "disabled:opacity-50 disabled:cursor-not-allowed " +
  "data-[placeholder]:text-fg-subtle " +
  "[&>span]:truncate [&>span]:text-left [&>span]:flex-1";

export function Select({
  value,
  onValueChange,
  placeholder,
  disabled,
  name,
  className,
  maxHeight = "320px",
  children,
}: SelectProps) {
  return (
    <RadixSelect.Root
      value={value || undefined}
      onValueChange={onValueChange}
      disabled={disabled}
      name={name}
    >
      <RadixSelect.Trigger className={className ?? triggerClass} aria-label={placeholder}>
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon className="text-fg-subtle">
          <ChevronDownIcon />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>

      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          className="z-50 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-border bg-bg shadow-xl"
          style={{ maxHeight }}
        >
          <RadixSelect.ScrollUpButton className="flex items-center justify-center h-6 bg-bg text-fg-subtle">
            <ChevronUpIcon />
          </RadixSelect.ScrollUpButton>
          <RadixSelect.Viewport className="p-1">
            {children}
          </RadixSelect.Viewport>
          <RadixSelect.ScrollDownButton className="flex items-center justify-center h-6 bg-bg text-fg-subtle">
            <ChevronDownIcon />
          </RadixSelect.ScrollDownButton>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}

interface SelectOptionProps {
  value: string;
  /** When true, the row is rendered but unselectable. */
  disabled?: boolean;
  children: ReactNode;
}

/**
 * One row inside a `<Select>`. Highlight + selected styling matches the
 * focus-ring / brand tokens used by Button.
 */
export const SelectOption = forwardRef<HTMLDivElement, SelectOptionProps>(
  ({ value, disabled, children }, ref) => (
    <RadixSelect.Item
      ref={ref}
      value={value}
      disabled={disabled}
      className={
        "relative flex items-center gap-2 px-3 py-1.5 text-[13px] text-fg rounded cursor-pointer outline-none " +
        "data-[highlighted]:bg-bg-surface data-[highlighted]:text-fg " +
        "data-[state=checked]:font-medium " +
        "data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed"
      }
    >
      <RadixSelect.ItemText>{children}</RadixSelect.ItemText>
      <RadixSelect.ItemIndicator className="ml-auto text-brand">
        <CheckIcon />
      </RadixSelect.ItemIndicator>
    </RadixSelect.Item>
  ),
);

SelectOption.displayName = "SelectOption";

/**
 * Optional non-interactive label inside the popover; useful when grouping
 * options (e.g. "Anthropic skills" / "Custom skills").
 */
export function SelectGroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-wider text-fg-subtle">
      {children}
    </div>
  );
}

/**
 * Wraps a set of SelectOptions as an ARIA-labelled group. Pair with
 * `SelectGroupLabel` for visual + accessibility labelling.
 */
export function SelectGroup({ children }: { children: ReactNode }) {
  return <RadixSelect.Group>{children}</RadixSelect.Group>;
}

/**
 * Visual divider between groups. Renders a thin border line in the popover.
 */
export function SelectSeparator() {
  return (
    <RadixSelect.Separator className="h-px bg-border my-1" />
  );
}

function ChevronDownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function ChevronUpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
