import { useMemo } from "react";
import { create } from "zustand";
import type { ApiClient } from "../lib/api-client";
import { workspaceService } from "../services";
import type {
  ConnectionStatus,
  EventMessage,
  ProjectSummary,
  RegistryKind,
  SessionSummary,
  WorkspaceSummary
} from "../types";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Module-level handle so we can drop the events subscription on reconnect. */
let eventsUnsubscribe: (() => void) | null = null;

function upsertSession(sessions: SessionSummary[], next: SessionSummary): SessionSummary[] {
  const index = sessions.findIndex((s) => s.id === next.id);
  if (index === -1) {
    return [...sessions, next];
  }
  const copy = [...sessions];
  copy[index] = { ...copy[index], ...next };
  return copy;
}

export interface AppState {
  api: ApiClient | null;
  connectionStatus: ConnectionStatus;

  // navigation
  currentWorkspace: string | null;
  currentProject: ProjectSummary | null;

  // data
  workspaces: WorkspaceSummary[];
  workspacesLoading: boolean;
  projects: ProjectSummary[];
  projectsLoading: boolean;

  /** All daemon sessions; a project's sessions are its tabs. */
  sessions: SessionSummary[];
  /** Client-local active tab per project path. */
  activeTabByProject: Record<string, string | null>;

  setApi: (api: ApiClient) => void;
  connect: () => Promise<void>;

  loadWorkspaces: () => Promise<void>;
  createWorkspace: (name: string) => Promise<void>;
  openWorkspace: (name: string) => Promise<void>;
  closeWorkspace: () => void;

  loadProjects: () => Promise<void>;
  createProject: (name: string) => Promise<void>;
  openProject: (project: ProjectSummary) => void;

  loadSessions: () => Promise<void>;
  openTab: (kind: RegistryKind, refId: string, title?: string) => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  activateTab: (id: string) => void;

  applyEvent: (event: EventMessage) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  api: null,
  connectionStatus: "connecting",
  currentWorkspace: null,
  currentProject: null,
  workspaces: [],
  workspacesLoading: false,
  projects: [],
  projectsLoading: false,
  sessions: [],
  activeTabByProject: {},

  setApi: (api) => set({ api }),

  connect: async () => {
    const api = get().api;
    if (!api) {
      return;
    }
    set({ connectionStatus: "connecting" });

    // The embedded daemon is spawned asynchronously: poll /health first.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (get().api !== api) {
        return;
      }
      try {
        await api.health();
        break;
      } catch {
        await delay(500);
        if (attempt === 59) {
          set({ connectionStatus: "error" });
          return;
        }
        continue;
      }
    }

    set({ connectionStatus: "connected" });
    await Promise.all([get().loadWorkspaces(), get().loadSessions()]);

    // Subscribe to the event bus for cross-client session sync.
    eventsUnsubscribe?.();
    eventsUnsubscribe = api.openEvents((event) => get().applyEvent(event));
  },

  loadWorkspaces: async () => {
    const api = get().api;
    if (!api) {
      return;
    }
    set({ workspacesLoading: true });
    try {
      set({ workspaces: await workspaceService.list(api) });
    } catch (error) {
      console.error("[orquester] failed to load workspaces", error);
    } finally {
      set({ workspacesLoading: false });
    }
  },

  createWorkspace: async (name) => {
    const api = get().api;
    if (!api) {
      return;
    }
    await workspaceService.create(api, name);
    await get().loadWorkspaces();
  },

  openWorkspace: async (name) => {
    set({ currentWorkspace: name, projects: [] });
    await get().loadProjects();
  },

  closeWorkspace: () => set({ currentWorkspace: null, projects: [] }),

  loadProjects: async () => {
    const api = get().api;
    const workspace = get().currentWorkspace;
    if (!api || !workspace) {
      set({ projects: [], projectsLoading: false });
      return;
    }
    set({ projectsLoading: true });
    try {
      set({ projects: await workspaceService.listProjects(api, workspace) });
    } catch (error) {
      console.error("[orquester] failed to load projects", error);
    } finally {
      set({ projectsLoading: false });
    }
  },

  createProject: async (name) => {
    const api = get().api;
    const workspace = get().currentWorkspace;
    if (!api || !workspace) {
      return;
    }
    await workspaceService.createProject(api, workspace, name);
    await get().loadProjects();
  },

  openProject: (project) =>
    set((state) => {
      const active = state.activeTabByProject[project.path];
      const fallback = state.sessions.find((s) => s.projectPath === project.path)?.id ?? null;
      return {
        currentProject: project,
        activeTabByProject: {
          ...state.activeTabByProject,
          [project.path]: active ?? fallback
        }
      };
    }),

  loadSessions: async () => {
    const api = get().api;
    if (!api) {
      return;
    }
    try {
      set({ sessions: await api.listSessions() });
    } catch (error) {
      console.error("[orquester] failed to load sessions", error);
    }
  },

  openTab: async (kind, refId, title) => {
    const api = get().api;
    if (!api) {
      return;
    }
    const project = get().currentProject;
    const session = await api.createSession({
      kind,
      refId,
      title,
      projectPath: project?.path ?? "",
      cwd: project?.path
    });
    set((state) => ({
      sessions: upsertSession(state.sessions, session),
      activeTabByProject: project
        ? { ...state.activeTabByProject, [project.path]: session.id }
        : state.activeTabByProject
    }));
  },

  closeTab: async (id) => {
    const api = get().api;
    set((state) => removeSession(state, id));
    await api?.closeSession(id).catch(() => undefined);
  },

  activateTab: (id) =>
    set((state) => {
      const project = state.currentProject;
      if (!project) {
        return state;
      }
      return { activeTabByProject: { ...state.activeTabByProject, [project.path]: id } };
    }),

  applyEvent: (event) => {
    if (event.channel !== "sessions") {
      return;
    }
    if (event.type === "session.created" || event.type === "session.exited") {
      const summary = event.payload as SessionSummary;
      set((state) => ({ sessions: upsertSession(state.sessions, summary) }));
    } else if (event.type === "session.closed") {
      const { id } = event.payload as { id: string };
      set((state) => removeSession(state, id));
    }
  }
}));

function removeSession(state: AppState, id: string): Partial<AppState> {
  const sessions = state.sessions.filter((s) => s.id !== id);
  const activeTabByProject = { ...state.activeTabByProject };
  for (const [path, activeId] of Object.entries(activeTabByProject)) {
    if (activeId === id) {
      activeTabByProject[path] = sessions.find((s) => s.projectPath === path)?.id ?? null;
    }
  }
  return { sessions, activeTabByProject };
}

/** Sessions (tabs) of the currently open project. */
export function useProjectSessions(): SessionSummary[] {
  const sessions = useAppStore((s) => s.sessions);
  const project = useAppStore((s) => s.currentProject);
  return useMemo(
    () => (project ? sessions.filter((s) => s.projectPath === project.path) : []),
    [sessions, project]
  );
}

export function useActiveSessionId(): string | null {
  return useAppStore((s) =>
    s.currentProject ? (s.activeTabByProject[s.currentProject.path] ?? null) : null
  );
}
