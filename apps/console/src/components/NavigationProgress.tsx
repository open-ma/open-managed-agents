import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigation } from "react-router";

/**
 * Top-of-viewport navigation progress bar.
 *
 * Two signals drive it:
 *   1. React Router's `useNavigation().state` — when the router is
 *      transitioning (data loading, lazy route boot), state goes
 *      from "idle" to "loading"/"submitting".
 *   2. Pathname change via `useLocation` — when the URL changes (no
 *      data router involved), we still want to show a progress hint
 *      because the page-level component is about to re-render and
 *      its own useEffect will fetch.
 *
 * The bar:
 *   - 0 → 80% over 400ms when nav starts (deceleration so it slows
 *     down before completion to suggest "almost there")
 *   - 80 → 100% the moment nav settles + a 200ms fade-out
 *   - Hidden by default (no DOM impact when idle)
 *
 * Uses `transform: scaleX()` on a fixed-positioned bar — GPU-accelerated,
 * never causes layout. Brand color so users associate the motion with
 * the product.
 */
export function NavigationProgress() {
  const location = useLocation();
  // useNavigation only works inside a data router. In our setup
  // (BrowserRouter + Routes), it returns idle always — but we still
  // import it defensively for the future migration to data routing.
  const navigation = useNavigation();

  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  const lastPath = useRef(location.pathname);
  const finishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (lastPath.current === location.pathname && navigation.state === "idle") {
      return;
    }
    // Path changed: kick off the bar.
    lastPath.current = location.pathname;
    if (finishTimer.current) clearTimeout(finishTimer.current);
    setVisible(true);
    setProgress(0);
    // Start the climb on the next frame so the 0 → 80 animation runs.
    requestAnimationFrame(() => setProgress(80));
    // Settle after a short window — most pages mount + first paint
    // within ~150-300ms after URL change. Tuned conservatively.
    finishTimer.current = setTimeout(() => {
      setProgress(100);
      finishTimer.current = setTimeout(() => {
        setVisible(false);
        setProgress(0);
      }, 200);
    }, 350);
    return () => {
      if (finishTimer.current) clearTimeout(finishTimer.current);
    };
  }, [location.pathname, navigation.state]);

  return (
    <div
      aria-hidden="true"
      className="fixed top-0 left-0 right-0 z-[60] pointer-events-none h-[2px]"
      style={{ opacity: visible ? 1 : 0, transition: "opacity 200ms ease-out" }}
    >
      <div
        className="h-full bg-brand origin-left"
        style={{
          transform: `scaleX(${progress / 100})`,
          transition: progress === 80
            ? "transform 400ms cubic-bezier(0.25, 1, 0.5, 1)"
            : progress === 100
              ? "transform 150ms ease-out"
              : "none",
        }}
      />
    </div>
  );
}
