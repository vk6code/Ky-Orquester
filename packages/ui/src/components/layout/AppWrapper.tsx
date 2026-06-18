import React from "react";
import { cn } from "../../lib/cn";
import { useViewportHeight } from "../../hooks";

export interface AppWrapperProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * Outermost shell of the app. Sized to the *visual* viewport height so the
 * layout always sits above the on-screen keyboard (no overlay, no scroll
 * jumps); sets the monochrome base palette and disables text selection so the
 * chrome behaves like native UI.
 */
export const AppWrapper: React.FC<AppWrapperProps> = ({ children, className }) => {
  const height = useViewportHeight();
  return (
    <div
      style={{ height: height || undefined }}
      className={cn(
        "flex h-screen w-screen flex-col overflow-hidden bg-neutral-950 text-neutral-200",
        "select-none antialiased",
        className
      )}
    >
      {children}
    </div>
  );
};
