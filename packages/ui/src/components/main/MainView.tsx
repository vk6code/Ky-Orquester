import React from "react";
import { LayoutGrid, MousePointerClick } from "lucide-react";
import { cn } from "../../lib/cn";
import { EmptyState } from "./EmptyState";
import { TerminalView } from "../terminal";
import { useActiveSessionId, useAppStore, useProjectSessions } from "../../store/app";

/**
 * Main panel. Every session of the current project is kept mounted (its output
 * stream stays open) and only the active one is shown, so switching tabs never
 * tears a terminal down.
 */
export const MainView: React.FC = () => {
  const currentProject = useAppStore((s) => s.currentProject);
  const sessions = useProjectSessions();
  const activeId = useActiveSessionId();

  let body: React.ReactNode;

  if (!currentProject) {
    body = (
      <EmptyState
        icon={<LayoutGrid size={40} strokeWidth={1.25} />}
        title="No project selected"
        description="Pick a workspace and open a project from the sidebar to get started."
      />
    );
  } else if (sessions.length === 0) {
    body = (
      <EmptyState
        icon={<MousePointerClick size={40} strokeWidth={1.25} />}
        title="No tabs open"
        description='Use the "+" button in the top bar to open a terminal or agent.'
      />
    );
  } else {
    body = sessions.map((session) => (
      <div
        key={session.id}
        className={cn("h-full w-full", session.id === activeId ? "block" : "hidden")}
      >
        <TerminalView session={session} />
      </div>
    ));
  }

  return <main className="min-h-0 flex-1 overflow-hidden bg-neutral-950">{body}</main>;
};
