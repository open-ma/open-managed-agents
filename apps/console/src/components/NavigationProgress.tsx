import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";

/**
 * Top-of-viewport navigation progress bar.
 *
 * Detects nav via `useLocation` pathname change (works in BrowserRouter
 * + Routes; unlike `useNavigation` which requires the data router).
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

  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  const lastPath = useRef(location.pathname);
  const finishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (lastPath.current === location.pathname) return;
    lastPath.current = location.pathname;
    if (finishTimer.current) clearTimeout(finishTimer.current);
    setVisible(true);
    setProgress(0);
    requestAnimationFrame(() => setProgress(80));
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
  }, [location.pathname]);

  return (
    <div
      aria-hidden="true"
      className="nav-progress-root fixed top-0 left-0 right-0 z-[60] pointer-events-none h-[2px]"
      style={{ opacity: visible ? 1 : 0, transition: "opacity 200ms ease-out" }}
    >
      <div
        className="nav-progress-bar h-full bg-brand origin-left"
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
