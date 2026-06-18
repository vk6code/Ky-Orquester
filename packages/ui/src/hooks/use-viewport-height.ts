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
    return () => {
      window.visualViewport?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  return height;
}
