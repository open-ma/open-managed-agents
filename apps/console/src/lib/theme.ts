import { useCallback, useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";

function getEffective(theme: Theme): "light" | "dark" {
  if (theme === "system") {
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme;
}

function apply(effective: "light" | "dark") {
  document.documentElement.classList.toggle("dark", effective === "dark");
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    return (localStorage.getItem("theme") as Theme) || "system";
  });

  const effective = getEffective(theme);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    if (t === "system") {
      localStorage.removeItem("theme");
    } else {
      localStorage.setItem("theme", t);
    }
    apply(getEffective(t));
  }, []);

  // Listen for system preference changes when in "system" mode
  useEffect(() => {
    if (theme !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const handler = () => apply(getEffective("system"));
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  // Apply on mount
  useEffect(() => {
    apply(effective);
  }, [effective]);

  return { theme, effective, setTheme } as const;
}
