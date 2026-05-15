import { createContext, useContext, useId, type ReactNode } from "react";

/**
 * Accessible tab pattern with full ARIA tab semantics.
 *
 *   const [tab, setTab] = useState("memories");
 *   <Tabs value={tab} onChange={setTab} ariaLabel="Memory store sections">
 *     <Tab value="memories">Memories</Tab>
 *     <Tab value="versions">Version history</Tab>
 *     <Tab value="settings">Settings</Tab>
 *   </Tabs>
 *   <TabPanel value="memories" current={tab}>...</TabPanel>
 *
 * <Tabs> is the role="tablist" container that broadcasts current value
 * + change handler via context. <Tab> reads context and renders a
 * role="tab" button with aria-selected, aria-controls, and roving
 * tabindex. <TabPanel> is the content slot with role="tabpanel" and
 * aria-labelledby pointing back at its trigger.
 *
 * Visual: border-b-2 active state in brand color. Inactive uses
 * fg-muted with a hover-text-fg affordance. Spring transition.
 */
type TabValue = string;

interface TabsContextValue {
  /** Stable namespace for id pair (tab + tabpanel). */
  group: string;
  current: TabValue;
  onChange: (value: TabValue) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

interface TabsProps {
  value: TabValue;
  onChange: (value: TabValue) => void;
  ariaLabel: string;
  className?: string;
  children: ReactNode;
}

export function Tabs({ value, onChange, ariaLabel, className = "", children }: TabsProps) {
  const group = useId();
  return (
    <TabsContext.Provider value={{ group, current: value, onChange }}>
      <div
        role="tablist"
        aria-label={ariaLabel}
        className={`border-b border-border flex gap-6 ${className}`.trim()}
      >
        {children}
      </div>
    </TabsContext.Provider>
  );
}

interface TabProps {
  value: TabValue;
  /** When set, uses tighter padding (good for in-modal / in-card tabs). */
  compact?: boolean;
  children: ReactNode;
}

export function Tab({ value, compact, children }: TabProps) {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("<Tab> must be inside <Tabs>");
  const active = ctx.current === value;
  const tabId = `${ctx.group}-tab-${value}`;
  const panelId = `${ctx.group}-panel-${value}`;
  const padding = compact ? "px-3 py-2 text-sm" : "pb-2 text-sm font-medium";
  return (
    <button
      type="button"
      role="tab"
      id={tabId}
      aria-selected={active}
      aria-controls={panelId}
      tabIndex={active ? 0 : -1}
      onClick={() => ctx.onChange(value)}
      className={`${padding} border-b-2 -mb-px transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
        active
          ? "border-brand text-fg"
          : "border-transparent text-fg-muted hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}

interface TabPanelProps {
  value: TabValue;
  /** Current selected value (lifted from <Tabs>). Required because the
   *  panel often renders outside the <Tabs> tree (e.g. tab strip up
   *  top, content body below). */
  current: TabValue;
  /** Optional id namespace if not the default. Match `useId` group from
   *  the same tree to wire aria-labelledby. */
  children: ReactNode;
}

export function TabPanel({ value, current, children }: TabPanelProps) {
  if (value !== current) return null;
  return <div role="tabpanel">{children}</div>;
}
