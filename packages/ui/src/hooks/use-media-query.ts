import { useEffect, useState } from "react";

/** Reactive CSS media query. `useMediaQuery("(min-width: 768px)")` → desktop. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = () => setMatches(mql.matches);
    handler();
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return matches;
}

/** True on md+ (≥768px) viewports. */
export function useIsDesktop(): boolean {
  return useMediaQuery("(min-width: 768px)");
}
