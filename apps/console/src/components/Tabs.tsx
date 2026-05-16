import { type ReactNode } from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

/**
 * Accessible tab pattern built on @radix-ui/react-tabs.
 *
 *   const [tab, setTab] = useState("memories");
 *   <TabsRoot value={tab} onValueChange={setTab} aria-label="Memory store sections">
 *     <TabList>
 *       <Tab value="memories">Memories</Tab>
 *       <Tab value="versions">Version history</Tab>
 *       <Tab value="settings">Settings</Tab>
 *     </TabList>
 *     <TabPanel value="memories">...</TabPanel>
 *     <TabPanel value="versions">...</TabPanel>
 *     <TabPanel value="settings">...</TabPanel>
 *   </TabsRoot>
 *
 * Radix gives us free Left/Right arrow cycling, Home/End jump, roving
 * tabindex, ARIA wiring (id, aria-controls, aria-selected, aria-labelledby),
 * and Tab-key focus shift from trigger into the active panel. Inactive
 * panels are unmounted (same shape as the old hand-rolled `current` check).
 *
 * Visual: border-b-2 active state in brand color, fg-muted text with a
 * hover-text-fg affordance. Spring transition. The `compact` Tab variant
 * tightens padding for in-modal / in-card tab strips.
 */
type TabValue = string;

interface TabsRootProps {
  value: TabValue;
  onValueChange: (value: TabValue) => void;
  orientation?: "horizontal" | "vertical";
  dir?: "ltr" | "rtl";
  /** "automatic" (default): focusing a trigger selects it. "manual":
   *  arrow keys move focus only; Enter/Space activates. */
  activationMode?: "automatic" | "manual";
  className?: string;
  "aria-label"?: string;
  children: ReactNode;
}

export function TabsRoot({
  value,
  onValueChange,
  orientation,
  dir,
  activationMode,
  className,
  "aria-label": ariaLabel,
  children,
}: TabsRootProps) {
  return (
    <TabsPrimitive.Root
      value={value}
      onValueChange={onValueChange}
      orientation={orientation}
      dir={dir}
      activationMode={activationMode}
      className={className}
      aria-label={ariaLabel}
    >
      {children}
    </TabsPrimitive.Root>
  );
}

interface TabListProps {
  /** Extra classes appended after defaults (border-b border-border flex gap-6). */
  className?: string;
  children: ReactNode;
}

export function TabList({ className = "", children }: TabListProps) {
  return (
    <TabsPrimitive.List
      className={`border-b border-border flex gap-6 ${className}`.trim()}
    >
      {children}
    </TabsPrimitive.List>
  );
}

interface TabProps {
  value: TabValue;
  /** When set, uses tighter padding (good for in-modal / in-card tabs). */
  compact?: boolean;
  children: ReactNode;
}

export function Tab({ value, compact, children }: TabProps) {
  const padding = compact ? "px-3 py-2 text-sm" : "pb-2 text-sm font-medium";
  return (
    <TabsPrimitive.Trigger
      value={value}
      className={`${padding} min-h-11 sm:min-h-0 border-b-2 -mb-px transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] border-transparent text-fg-muted hover:text-fg data-[state=active]:border-brand data-[state=active]:text-fg`}
    >
      {children}
    </TabsPrimitive.Trigger>
  );
}

interface TabPanelProps {
  value: TabValue;
  className?: string;
  children: ReactNode;
}

export function TabPanel({ value, className, children }: TabPanelProps) {
  return (
    <TabsPrimitive.Content value={value} className={className}>
      {children}
    </TabsPrimitive.Content>
  );
}
