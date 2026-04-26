import { useEffect, useRef, useState } from "react";

// Cloudflare Turnstile widget — vanilla CF JS, no dependency.
//
// Loads `https://challenges.cloudflare.com/turnstile/v0/api.js` on mount
// (idempotent — once per page) and renders a widget into the host div.
// Calls `onToken` when CF mints a token; `onExpire` when it expires
// (Turnstile tokens are single-use AND short-lived, ~5 min).
//
// Pass `siteKey={null}` to render a no-op placeholder — this happens when
// the backend hasn't been configured with a Turnstile site yet, in which
// case the auth middleware soft-passes too.

interface TurnstileProps {
  siteKey: string | null;
  onToken: (token: string) => void;
  onExpire?: () => void;
  /** "auto" (default) shows the widget if interaction is needed; "always"
   *  forces a visible widget; "size: invisible" requires the widget to
   *  call its action programmatically (we use the simpler default). */
  appearance?: "auto" | "always-visible";
}

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          "expired-callback"?: () => void;
          "error-callback"?: () => void;
          appearance?: "auto" | "always" | "execute";
          theme?: "light" | "dark" | "auto";
        },
      ) => string;
      remove: (widgetId: string) => void;
      reset: (widgetId: string) => void;
    };
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";
let scriptLoaded: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (scriptLoaded) return scriptLoaded;
  scriptLoaded = new Promise<void>((resolve, reject) => {
    if (window.turnstile) {
      resolve();
      return;
    }
    const existing = document.querySelector(`script[src="${SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Turnstile script failed to load")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Turnstile script failed to load"));
    document.head.appendChild(script);
  });
  return scriptLoaded;
}

export function Turnstile({ siteKey, onToken, onExpire, appearance = "auto" }: TurnstileProps) {
  const ref = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    if (!siteKey || !ref.current) return;
    let cancelled = false;
    loadTurnstileScript()
      .then(() => {
        if (cancelled || !window.turnstile || !ref.current) return;
        widgetId.current = window.turnstile.render(ref.current, {
          sitekey: siteKey,
          callback: onToken,
          "expired-callback": onExpire,
          "error-callback": () => setError("Bot challenge failed to load. Please refresh."),
          appearance: appearance === "always-visible" ? "always" : "auto",
          theme: "auto",
        });
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) {
        try { window.turnstile.remove(widgetId.current); } catch {}
        widgetId.current = null;
      }
    };
  }, [siteKey, onToken, onExpire, appearance]);

  if (!siteKey) return null;

  return (
    <div className="space-y-1">
      <div ref={ref} />
      {error && <div className="text-xs text-danger">{error}</div>}
    </div>
  );
}
