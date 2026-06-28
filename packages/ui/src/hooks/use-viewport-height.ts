import { useEffect, useState } from "react";

/**
 * The visual viewport height in px (falls back to innerHeight). Used to size
 * the app shell so it always fits *above* the on-screen keyboard — the layout
 * (and the in-flow terminal + key bar) deterministically resizes instead of
 * being overlaid, avoiding scroll jumps and element flashes.
 */
export function useViewportHeight(): number {
  const [height, setHeight] = useState(() =>
    typeof window === "undefined" ? 0 : window.visualViewport?.height ?? window.innerHeight
  );

  useEffect(() => {
    const update = () => setHeight(window.visualViewport?.height ?? window.innerHeight);
    update();
    window.visualViewport?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    // iOS/Android often report a stale viewport height after returning from
    // background; visibilitychange forces a recalculation.
    const handleVisibility = () => {
      if (!document.hidden) {
        requestAnimationFrame(update);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.visualViewport?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  return height;
}
