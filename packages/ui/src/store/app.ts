import { useMemo } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { ApiClient, ApiError } from "../lib/api-client";
import { createTransporter } from "../lib/transporters";
import { toRemoteConfig, toUiConnection } from "../lib/connections";
import { clearStoredHash, deriveAuthHash, loadStoredHash, storeHash } from "../lib/auth";
import { genId } from "../lib/id";
import type { AppConfigAdapter } from "../lib/app-config";
import type { HttpClient } from "../lib/http-client";
import type { Transporter } from "../lib/transporter";
import { workspaceService } from "../services";
import type {
  AgentLoopRequest,
  AgentLoopResponse,
  AgentLoopStatus,
  ConnectionStatus,
  EventMessage,
  ProjectSummary,
  RegistryEntry,
  RegistryKind,
  RegistryResponse,
  SessionSummary,
  UiConnection,
  WorkspaceSummary
} from "../types";
import type { Gorila360PlanSummary } from "../types";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const EMPTY_REGISTRY: RegistryResponse = {
  shells: [],
  agents: [],
  ides: [],
  fileExplorers: [],
  browsers: []
};

/** Replace a registry entry (matched by id within its kind) with a fresh copy. */
function applyRegistryEntry(registry: RegistryResponse, entry: RegistryEntry): RegistryResponse {
  const key = (
    {
      shell: "shells",
      agent: "agents",
      ide: "ides",
      "file-explorer": "fileExplorers",
      browser: "browsers"
    } as const
  )[entry.kind];
  const list = registry[key];
  const index = list.findIndex((e) => e.id === entry.id);
  const next = index === -1 ? [...list, entry] : list.map((e) => (e.id === entry.id ? entry : e));
  return { ...registry, [key]: next };
}

/** Module-level handle so we can drop the events subscription on reconnect. */
let eventsUnsubscribe: (() => void) | null = null;
/** Generation guard so a stale events stream's onEnd doesn't trigger reconnect. */
let eventsGen = 0;
/** Periodic health probe that detects a dropped/restarted transport. */
let healthTimer: ReturnType<typeof setInterval> | null = null;
/** Mobile visibility handler; removed on reconnect/sign-out. */
let visibilityHandler: (() => void) | null = null;
/** Guards against overlapping reconnect loops. */
let reconnecting = false;

function stopHealthProbe(): void {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
}

/** Intentionally drop the events subscription (bumps gen so its onEnd is ignored). */
function closeEvents(): void {
  eventsGen += 1;
  eventsUnsubscribe?.();
  eventsUnsubscribe = null;
  if (visibilityHandler) {
    document.removeEventListener("visibilitychange", visibilityHandler);
    visibilityHandler = null;
  }
}

/** Host-provided connection wiring, set once via initConnections(). */
interface ConnectionSetup {
  localConnection: UiConnection;
  /** Injected transport for the local connection (desktop unix socket). */
  localTransporter?: Transporter;
  /** Custom HTTP client for remote transporters (rarely needed). */
  httpClient?: HttpClient;
  /**
   * App-config persistence. Web injects a localStorage adapter; desktop omits
   * it, so app config is read/written on the daemon (app.json), while remotes
   * always live on the daemon (shared).
   */
  appConfigAdapter?: AppConfigAdapter;
  /** Fallback for useTitlebar when app config doesn't specify it. */
  defaultUseTitlebar: boolean;
}

let setup: ConnectionSetup | null = null;

/**
 * The "home" daemon (the initial/local connection). App config and the remote
 * server list are persisted here so every client of this daemon shares them,
 * independent of which connection is currently active.
 */
let homeApi: ApiClient | null = null;

export interface UiAppConfig {
  useTitlebar: boolean;
  runInBackground: boolean;
}

/** Persist the remote-server list to the home daemon (shared across clients). */
async function persistRemotes(connections: UiConnection[]): Promise<void> {
  await homeApi
    ?.saveRemotes(connections.filter((c) => c.kind === "remote").map(toRemoteConfig))
    .catch(() => undefined);
}

/** Rebuild an ApiClient for the same connection but with a bearer credential. */
function apiWithPassword(api: ApiClient, password: string): ApiClient {
  const connection: UiConnection = { ...api.connection, password };
  return new ApiClient(connection, buildTransporter(connection));
}

/** Build the transporter for a connection: local uses the injected one. */
function buildTransporter(connection: UiConnection): Transporter {
  if (setup && connection.id === setup.localConnection.id && setup.localTransporter) {
    return setup.localTransporter;
  }
  return createTransporter(connection, { httpClient: setup?.httpClient });
}

/** A client-local, non-PTY tab (e.g. the file browser). */
export interface FileTab {
  id: string;
  projectPath: string;
  title: string;
}

/** A client-local Gorila360 plans tab. */
export interface PlansTab {
  id: string;
  projectPath: string;
  title: string;
}

/** A client-local generic loop runner tab. */
export interface LoopTab {
  id: string;
  projectPath: string;
  title: string;
}

/** A client-local multi-directory agent launcher tab. */
export interface AgentLauncherTab {
  id: string;
  projectPath: string;
  title: string;
}

/** A tab in the current project: a daemon session or a local tool tab. */
export type ProjectTab =
  | { id: string; type: "session"; session: SessionSummary }
  | { id: string; type: "files"; title: string }
  | { id: string; type: "plans"; title: string }
  | { id: string; type: "loops"; title: string }
  | { id: string; type: "agent-launcher"; title: string };

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
  /** >0 while auto-reconnecting (drives the "Reconnecting… attempt N" toast). */
  reconnectAttempt: number;

  // connections (local daemon + user-added remotes)
  connections: UiConnection[];
  activeConnectionId: string | null;

  // app config + settings modal
  appConfig: UiAppConfig;
  settingsOpen: boolean;
  sidebarCollapsed: boolean;
  /** Mobile off-canvas sidebar drawer. */
  sidebarDrawerOpen: boolean;

  // auth (web → password-protected HTTP daemon)
  authPrompt: { connectionId: string } | null;
  authSalt: string | null;

  // navigation
  currentWorkspace: string | null;
  currentProject: ProjectSummary | null;

  // data
  registry: RegistryResponse;
  workspaces: WorkspaceSummary[];
  workspacesLoading: boolean;
  projects: ProjectSummary[];
  projectsLoading: boolean;
  /** Display-only name overrides for workspaces/projects, keyed by abs path. */
  labels: Record<string, string>;
  /** Workspace/project paths hidden from the sidebar (disk untouched). */
  hidden: string[];
  /** Live status of the current/last multi-agent relay loop (null if none). */
  agentLoop: AgentLoopStatus | null;

  /** All daemon sessions; a project's sessions are its tabs. */
  sessions: SessionSummary[];
  /** Client-local tool tabs (file browser) per project path. */
  fileTabsByProject: Record<string, FileTab[]>;
  /** Client-local Gorila360 plans tabs per project path. */
  plansTabsByProject: Record<string, PlansTab[]>;
  /** Client-local generic loop runner tabs per project path. */
  loopTabsByProject: Record<string, LoopTab[]>;
  /** Client-local multi-directory agent launcher tabs per project path. */
  agentTabsByProject: Record<string, AgentLauncherTab[]>;
  /** Client-local active tab id per project path (session or file tab). */
  activeTabByProject: Record<string, string | null>;

  setApi: (api: ApiClient) => void;
  connect: () => Promise<void>;
  /** Establish a connected session on an ApiClient (auth, load, subscribe, probe). */
  establish: (api: ApiClient) => Promise<void>;
  /** Called when the transport drops; runs the reconnect loop. */
  handleDisconnect: () => void;

  // connection management
  initConnections: (setup: ConnectionSetup) => Promise<void>;
  selectConnection: (id: string) => Promise<void>;
  addRemote: (input: { name: string; baseUrl: string; password?: string }) => Promise<string>;
  removeRemote: (id: string) => Promise<void>;
  renameRemote: (id: string, name: string) => Promise<void>;
  loadRemotes: () => Promise<void>;

  // app config + settings
  loadAppConfig: () => Promise<void>;
  setSettingsOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setSidebarDrawer: (open: boolean) => void;
  updateAppConfig: (patch: Partial<UiAppConfig>) => Promise<void>;

  // auth
  submitPassword: (password: string) => Promise<void>;
  signOut: () => void;

  loadWorkspaces: () => Promise<void>;
  createWorkspace: (name: string) => Promise<void>;
  openWorkspace: (name: string) => Promise<void>;
  closeWorkspace: () => void;

  loadProjects: () => Promise<void>;
  createProject: (name: string, linkPath?: string) => Promise<void>;
  openProject: (project: ProjectSummary) => void;

  /** Load display-name overrides for the active daemon. */
  loadLabels: () => Promise<void>;
  /** Set (or clear, when blank) a display name for a workspace/project path. */
  setLabel: (path: string, name: string) => Promise<void>;

  /** Load the hidden workspace/project list for the active daemon. */
  loadHidden: () => Promise<void>;
  /** Hide or restore a workspace/project in the sidebar (disk untouched). */
  setHidden: (path: string, hidden: boolean) => Promise<void>;

  /** Start a multi-agent relay loop; returns the launch response. */
  startAgentLoop: (req: AgentLoopRequest) => Promise<AgentLoopResponse>;
  /** Ask the active relay loop to stop after the current turn. */
  stopAgentLoop: () => Promise<void>;

  loadSessions: () => Promise<void>;
  loadRegistry: () => Promise<void>;
  installAgent: (id: string) => Promise<void>;
  updateAgent: (id: string) => Promise<void>;
  openTab: (kind: RegistryKind, refId: string, title?: string) => Promise<void>;
  openFileBrowser: () => void;
  openGorila360Plans: () => void;
  openLoopRunner: () => void;
  openAgentLauncher: () => void;
  /** Launch an agent session with a base cwd + extra working dirs (multi-root). */
  launchAgentWorkspace: (input: {
    refId: string;
    title?: string;
    cwd: string;
    extraDirs: string[];
  }) => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  activateTab: (id: string) => void;

  applyEvent: (event: EventMessage) => void;
}

/**
 * Persist a small slice of navigation state (which project is open + the
 * client-local tabs) so reopening the app — e.g. after backgrounding it on a
 * phone — drops you back where you were instead of an empty workspace list.
 * The daemon keeps the PTYs alive regardless; this only restores the UI.
 *
 * The snapshot expires after PERSIST_TTL_MS: come back within the window and
 * everything is restored; after it, you start clean.
 */
const PERSIST_KEY = "orquester-nav";
const PERSIST_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

const ttlStorage = createJSONStorage(() => ({
  getItem: (name: string): string | null => {
    try {
      if (typeof localStorage === "undefined") return null;
      const raw = localStorage.getItem(name);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { savedAt?: number; blob?: string };
      if (
        typeof parsed.blob !== "string" ||
        typeof parsed.savedAt !== "number" ||
        Date.now() - parsed.savedAt > PERSIST_TTL_MS
      ) {
        localStorage.removeItem(name);
        return null;
      }
      return parsed.blob;
    } catch {
      return null;
    }
  },
  setItem: (name: string, value: string): void => {
    try {
      if (typeof localStorage === "undefined") return;
      localStorage.setItem(name, JSON.stringify({ savedAt: Date.now(), blob: value }));
    } catch {
      /* quota exceeded / storage unavailable */
    }
  },
  removeItem: (name: string): void => {
    try {
      if (typeof localStorage !== "undefined") localStorage.removeItem(name);
    } catch {
      /* ignore */
    }
  }
}));

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
  api: null,
  connectionStatus: "connecting",
  reconnectAttempt: 0,
  connections: [],
  activeConnectionId: null,
  appConfig: { useTitlebar: false, runInBackground: false },
  settingsOpen: false,
  sidebarCollapsed: false,
  sidebarDrawerOpen: false,
  authPrompt: null,
  authSalt: null,
  currentWorkspace: null,
  currentProject: null,
  registry: EMPTY_REGISTRY,
  workspaces: [],
  workspacesLoading: false,
  projects: [],
  projectsLoading: false,
  labels: {},
  hidden: [],
  agentLoop: null,
  sessions: [],
  fileTabsByProject: {},
  plansTabsByProject: {},
  loopTabsByProject: {},
  agentTabsByProject: {},
  activeTabByProject: {},

  setApi: (api) => set({ api }),

  connect: async () => {
    const initial = get().api;
    if (!initial) {
      return;
    }
    stopHealthProbe();
    reconnecting = false;
    set({ connectionStatus: "connecting", reconnectAttempt: 0 });

    // The embedded daemon is spawned asynchronously: poll /health first.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (get().api !== initial) {
        return;
      }
      try {
        await initial.health();
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

    await get().establish(initial);
  },

  establish: async (api) => {
    // Auth gate: derive/restore the bcrypt-hash bearer (web) or prompt.
    let active = api;
    const info = await active.authInfo().catch(() => null);
    set({ authSalt: info?.salt ?? null });
    if (info?.authRequired) {
      const hash = active.connection.password ?? loadStoredHash(active.connection.endpoint);
      if (!hash) {
        stopHealthProbe();
        set({ connectionStatus: "error", reconnectAttempt: 0, authPrompt: { connectionId: active.connection.id } });
        return;
      }
      if (active.connection.password !== hash) {
        active = apiWithPassword(active, hash);
        set({ api: active });
      }
    }

    // Load data first; any 401 will sign out and stop here.
    try {
      await Promise.all([
        get().loadWorkspaces(),
        get().loadSessions(),
        get().loadRegistry(),
        get().loadLabels(),
        get().loadHidden()
      ]);
    } catch {
      // signOut is called by the loader that received 401.
      return;
    }

    // Auth is valid: persist the hash and mark connected.
    if (info?.authRequired && active.connection.password) {
      storeHash(active.connection.endpoint, active.connection.password);
    }
    set({ connectionStatus: "connected", reconnectAttempt: 0, authPrompt: null });

    // If a workspace was restored from a previous session (persisted nav state),
    // load its projects so the restored project + tabs render instead of an
    // empty list.
    if (get().currentWorkspace && get().projects.length === 0) {
      void get().loadProjects();
    }

    // Live event sync. The stream ending unexpectedly (e.g. the transport was
    // restarted) is the primary disconnect signal.
    closeEvents();
    const gen = eventsGen;
    eventsUnsubscribe = active.openEvents(
      (event) => get().applyEvent(event),
      () => {
        if (gen === eventsGen) {
          get().handleDisconnect();
        }
      }
    );

    // Health probe: detect a dropped/restarted transport and auto-reconnect.
    stopHealthProbe();
    healthTimer = setInterval(() => {
      const current = get().api;
      if (current) {
        void current.health().catch(() => get().handleDisconnect());
      }
    }, 4000);

    // Mobile browsers kill background connections; try to heal the event stream
    // when the page becomes visible again, but only if we're not waiting for auth.
    visibilityHandler = () => {
      const currentApi = get().api;
      if (!document.hidden && get().authPrompt === null && eventsUnsubscribe === null && currentApi) {
        void get().establish(currentApi);
      }
    };
    document.addEventListener("visibilitychange", visibilityHandler);
  },

  handleDisconnect: () => {
    stopHealthProbe();
    // If the user is already being prompted for a password, don't auto-reconnect
    // with the stale/invalid credential; that would create an infinite 401 loop.
    if (reconnecting || get().api === null || get().authPrompt !== null) {
      return;
    }
    reconnecting = true;

    const loop = async () => {
      for (let attempt = 1; attempt <= 30; attempt += 1) {
        const current = get().api;
        if (!current || get().authPrompt !== null) {
          break;
        }
        set({ connectionStatus: "connecting", reconnectAttempt: attempt });
        try {
          await current.health();
          // Daemon is back: rebuild the client so terminals + event streams
          // re-subscribe to the (intact) sessions, then re-establish.
          const password = current.connection.password || loadStoredHash(current.connection.endpoint);
          if (!password) {
            get().signOut();
            break;
          }
          const fresh = apiWithPassword(current, password);
          set({ api: fresh });
          await get().establish(fresh);
          break;
        } catch {
          await delay(Math.min(attempt * 1000, 8000));
        }
      }
      reconnecting = false;
    };
    void loop();
  },

  initConnections: async (nextSetup) => {
    setup = nextSetup;
    homeApi = new ApiClient(nextSetup.localConnection, buildTransporter(nextSetup.localConnection));
    set({
      connections: [nextSetup.localConnection],
      activeConnectionId: nextSetup.localConnection.id,
      appConfig: { useTitlebar: nextSetup.defaultUseTitlebar, runInBackground: false },
      api: homeApi
    });
    await get().connect();
    // App config + remote servers are shared (persisted on the home daemon).
    await Promise.all([get().loadAppConfig(), get().loadRemotes()]);
  },

  loadAppConfig: async () => {
    try {
      const adapter = setup?.appConfigAdapter;
      const config = adapter ? await adapter.load() : await homeApi?.getAppConfig();
      if (config) {
        set((state) => ({
          appConfig: {
            useTitlebar: config.useTitlebar ?? state.appConfig.useTitlebar,
            runInBackground: config.runInBackground ?? state.appConfig.runInBackground
          }
        }));
      }
    } catch {
      /* keep defaults */
    }
  },

  loadRemotes: async () => {
    if (!homeApi || !setup) {
      return;
    }
    try {
      const remotes = (await homeApi.listRemotes()).map(toUiConnection);
      set({ connections: [setup.localConnection, ...remotes] });
    } catch {
      /* keep local only */
    }
  },

  setSettingsOpen: (open) => set({ settingsOpen: open }),

  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

  setSidebarDrawer: (open) => set({ sidebarDrawerOpen: open }),

  updateAppConfig: async (patch) => {
    const appConfig = { ...get().appConfig, ...patch };
    set({ appConfig });
    const adapter = setup?.appConfigAdapter;
    const full = {
      version: 1 as const,
      activeConnectionId: get().activeConnectionId ?? "local",
      ...appConfig
    };
    const result = adapter ? adapter.save(full) : homeApi?.updateAppConfig(appConfig);
    await result?.catch(() => undefined);
  },

  submitPassword: async (password) => {
    const api = get().api;
    const salt = get().authSalt;
    if (!api || !salt) {
      return;
    }
    // Derive the same bcrypt hash the daemon stores and use it as the bearer.
    // Do NOT persist it yet; establish() will store it only after validation.
    const hash = deriveAuthHash(password, salt);
    set({ api: apiWithPassword(api, hash), authPrompt: null });
    await get().connect();
  },

  signOut: () => {
    const api = get().api;
    if (api) {
      stopHealthProbe();
      reconnecting = false;
      closeEvents();
      clearStoredHash(api.connection.endpoint);
      set({
        api: apiWithPassword(api, ""),
        connectionStatus: "error",
        reconnectAttempt: 0,
        authPrompt: { connectionId: api.connection.id }
      });
    }
  },

  selectConnection: async (id) => {
    const connection = get().connections.find((c) => c.id === id);
    if (!connection || id === get().activeConnectionId) {
      return;
    }
    stopHealthProbe();
    reconnecting = false;
    closeEvents();
    // Reset all daemon-scoped state: a different server has its own data.
    set({
      api: new ApiClient(connection, buildTransporter(connection)),
      activeConnectionId: id,
      currentWorkspace: null,
      currentProject: null,
      workspaces: [],
      projects: [],
      labels: {},
      hidden: [],
      sessions: [],
      fileTabsByProject: {},
      plansTabsByProject: {},
      loopTabsByProject: {},
      agentTabsByProject: {},
      activeTabByProject: {}
    });
    await get().connect();
  },

  addRemote: async (input) => {
    const connection: UiConnection = {
      id: genId(),
      name: input.name.trim() || input.baseUrl,
      kind: "remote",
      endpoint: input.baseUrl.trim().replace(/\/$/, ""),
      status: "disconnected",
      password: input.password?.trim() || undefined
    };
    const connections = [...get().connections, connection];
    set({ connections });
    await persistRemotes(connections);
    return connection.id;
  },

  removeRemote: async (id) => {
    const connections = get().connections.filter((c) => c.id !== id);
    set({ connections });
    await persistRemotes(connections);
    if (get().activeConnectionId === id && setup) {
      await get().selectConnection(setup.localConnection.id);
    }
  },

  renameRemote: async (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    const connections = get().connections.map((c) =>
      c.id === id && c.kind === "remote" ? { ...c, name: trimmed } : c
    );
    set({ connections });
    await persistRemotes(connections);
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
      // A wrong/stale token surfaces here — sign out completely and re-prompt.
      if (error instanceof ApiError && error.status === 401) {
        get().signOut();
      } else {
        console.error("[orquester] failed to load workspaces", error);
      }
      throw error;
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

  createProject: async (name, linkPath) => {
    const api = get().api;
    const workspace = get().currentWorkspace;
    if (!api || !workspace) {
      return;
    }
    await workspaceService.createProject(api, workspace, name, linkPath);
    await get().loadProjects();
  },

  openProject: (project) =>
    set((state) => {
      const active = state.activeTabByProject[project.path];
      const fallback = firstTabId(
        state.sessions,
        state.plansTabsByProject,
        state.loopTabsByProject,
        state.agentTabsByProject,
        state.fileTabsByProject,
        project.path
      );
      return {
        currentProject: project,
        // Opening a project reveals the main view — close the mobile drawer.
        sidebarDrawerOpen: false,
        activeTabByProject: {
          ...state.activeTabByProject,
          [project.path]: active ?? fallback
        }
      };
    }),

  loadLabels: async () => {
    const api = get().api;
    if (!api) {
      return;
    }
    try {
      set({ labels: await api.listLabels() });
    } catch {
      set({ labels: {} });
    }
  },

  setLabel: async (path, name) => {
    const api = get().api;
    if (!api) {
      return;
    }
    const trimmed = name.trim();
    const labels = { ...get().labels };
    if (trimmed) {
      labels[path] = trimmed;
    } else {
      delete labels[path];
    }
    set({ labels });
    await api.saveLabels(labels).catch(() => undefined);
  },

  loadHidden: async () => {
    const api = get().api;
    if (!api) {
      return;
    }
    try {
      set({ hidden: await api.listHidden() });
    } catch {
      set({ hidden: [] });
    }
  },

  setHidden: async (path, hidden) => {
    const api = get().api;
    if (!api) {
      return;
    }
    const next = hidden
      ? [...new Set([...get().hidden, path])]
      : get().hidden.filter((p) => p !== path);
    set({ hidden: next });
    await api.saveHidden(next).catch(() => undefined);
  },

  startAgentLoop: async (req) => {
    const api = get().api;
    if (!api) {
      throw new Error("Not connected.");
    }
    const res = await api.startAgentLoop(req);
    set({
      agentLoop: {
        loopId: res.loopId,
        sessionId: res.sessionId,
        round: 0,
        agent: res.agents[0] ?? "",
        state: "running"
      }
    });
    return res;
  },

  stopAgentLoop: async () => {
    const api = get().api;
    const loop = get().agentLoop;
    if (!api || !loop) {
      return;
    }
    await api.stopAgentLoop(loop.loopId).catch(() => undefined);
  },

  loadSessions: async () => {
    const api = get().api;
    if (!api) {
      return;
    }
    try {
      set({ sessions: await api.listSessions() });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        get().signOut();
        throw error;
      }
      console.error("[orquester] failed to load sessions", error);
    }
  },

  loadRegistry: async () => {
    const api = get().api;
    if (!api) {
      return;
    }
    try {
      set({ registry: await api.listRegistry() });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        get().signOut();
        throw error;
      }
      /* keep current */
    }
  },

  installAgent: async (id) => {
    // Status (installing/installed/error) arrives via the "registry" event bus.
    await get().api?.installRegistryEntry(id).catch(() => undefined);
  },

  updateAgent: async (id) => {
    await get().api?.updateRegistryEntry(id).catch(() => undefined);
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

  openFileBrowser: () =>
    set((state) => {
      const project = state.currentProject;
      if (!project) {
        return state;
      }
      const tab: FileTab = { id: genId(), projectPath: project.path, title: "Files" };
      return {
        fileTabsByProject: {
          ...state.fileTabsByProject,
          [project.path]: [...(state.fileTabsByProject[project.path] ?? []), tab]
        },
        activeTabByProject: { ...state.activeTabByProject, [project.path]: tab.id }
      };
    }),

  openGorila360Plans: () =>
    set((state) => {
      const project = state.currentProject;
      if (!project) {
        return state;
      }
      const existing = state.plansTabsByProject[project.path]?.[0];
      if (existing) {
        return { activeTabByProject: { ...state.activeTabByProject, [project.path]: existing.id } };
      }
      const tab: PlansTab = { id: genId(), projectPath: project.path, title: "Gorila360" };
      return {
        plansTabsByProject: {
          ...state.plansTabsByProject,
          [project.path]: [tab]
        },
        activeTabByProject: { ...state.activeTabByProject, [project.path]: tab.id }
      };
    }),

  openLoopRunner: () =>
    set((state) => {
      const project = state.currentProject;
      if (!project) {
        return state;
      }
      const existing = state.loopTabsByProject[project.path]?.[0];
      if (existing) {
        return { activeTabByProject: { ...state.activeTabByProject, [project.path]: existing.id } };
      }
      const tab: LoopTab = { id: genId(), projectPath: project.path, title: "Loop Runner" };
      return {
        loopTabsByProject: {
          ...state.loopTabsByProject,
          [project.path]: [tab]
        },
        activeTabByProject: { ...state.activeTabByProject, [project.path]: tab.id }
      };
    }),

  openAgentLauncher: () =>
    set((state) => {
      const project = state.currentProject;
      if (!project) {
        return state;
      }
      const existing = state.agentTabsByProject[project.path]?.[0];
      if (existing) {
        return { activeTabByProject: { ...state.activeTabByProject, [project.path]: existing.id } };
      }
      const tab: AgentLauncherTab = { id: genId(), projectPath: project.path, title: "Agent workspace" };
      return {
        agentTabsByProject: {
          ...state.agentTabsByProject,
          [project.path]: [tab]
        },
        activeTabByProject: { ...state.activeTabByProject, [project.path]: tab.id }
      };
    }),

  launchAgentWorkspace: async ({ refId, title, cwd, extraDirs }) => {
    const api = get().api;
    if (!api) {
      return;
    }
    const project = get().currentProject;
    const session = await api.createSession({
      kind: "agent",
      refId,
      title,
      projectPath: project?.path ?? cwd,
      cwd,
      extraDirs
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
    const isSession = get().sessions.some((s) => s.id === id);
    const isPlans = Object.values(get().plansTabsByProject).some((tabs) => tabs.some((t) => t.id === id));
    const isLoops = Object.values(get().loopTabsByProject).some((tabs) => tabs.some((t) => t.id === id));
    const isAgent = Object.values(get().agentTabsByProject).some((tabs) => tabs.some((t) => t.id === id));
    set((state) => {
      if (isSession) return removeSession(state, id);
      if (isPlans) return removePlansTab(state, id);
      if (isLoops) return removeLoopTab(state, id);
      if (isAgent) return removeAgentTab(state, id);
      return removeFileTab(state, id);
    });
    if (isSession) {
      await api?.closeSession(id).catch(() => undefined);
    }
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
    if (event.channel === "registry" && event.type === "registry.changed") {
      const entry = event.payload as RegistryEntry;
      set((state) => ({ registry: applyRegistryEntry(state.registry, entry) }));
      return;
    }
    if (event.channel === "agent-loops") {
      if (event.type === "agent-loop.turn" || event.type === "agent-loop.done") {
        const status = event.payload as AgentLoopStatus;
        // Ignore stale events from a previous loop the user has since replaced.
        if (get().agentLoop?.loopId === status.loopId) {
          set({ agentLoop: status });
        }
      }
      return;
    }
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
    }),
    {
      name: PERSIST_KEY,
      storage: ttlStorage,
      version: 1,
      // Only navigation state — never the api client, connections, or live
      // daemon data (sessions/workspaces are reloaded fresh on reconnect).
      partialize: (state) => ({
        currentWorkspace: state.currentWorkspace,
        currentProject: state.currentProject,
        activeTabByProject: state.activeTabByProject,
        fileTabsByProject: state.fileTabsByProject,
        plansTabsByProject: state.plansTabsByProject,
        loopTabsByProject: state.loopTabsByProject,
        agentTabsByProject: state.agentTabsByProject
      })
    }
  )
);

/** First remaining tab id for a project (session preferred, then loop/plans/agent/files). */
function firstTabId(
  sessions: SessionSummary[],
  plansTabs: Record<string, PlansTab[]>,
  loopTabs: Record<string, LoopTab[]>,
  agentTabs: Record<string, AgentLauncherTab[]>,
  fileTabs: Record<string, FileTab[]>,
  path: string
): string | null {
  return (
    sessions.find((s) => s.projectPath === path)?.id ??
    plansTabs[path]?.[0]?.id ??
    loopTabs[path]?.[0]?.id ??
    agentTabs[path]?.[0]?.id ??
    fileTabs[path]?.[0]?.id ??
    null
  );
}

function reassignActive(
  activeTabByProject: Record<string, string | null>,
  removedId: string,
  sessions: SessionSummary[],
  plansTabs: Record<string, PlansTab[]>,
  loopTabs: Record<string, LoopTab[]>,
  agentTabs: Record<string, AgentLauncherTab[]>,
  fileTabs: Record<string, FileTab[]>
): Record<string, string | null> {
  const next = { ...activeTabByProject };
  for (const [path, activeId] of Object.entries(next)) {
    if (activeId === removedId) {
      next[path] = firstTabId(sessions, plansTabs, loopTabs, agentTabs, fileTabs, path);
    }
  }
  return next;
}

function removeSession(state: AppState, id: string): Partial<AppState> {
  const sessions = state.sessions.filter((s) => s.id !== id);
  return {
    sessions,
    activeTabByProject: reassignActive(
      state.activeTabByProject,
      id,
      sessions,
      state.plansTabsByProject,
      state.loopTabsByProject,
      state.agentTabsByProject,
      state.fileTabsByProject
    )
  };
}

function removeFileTab(state: AppState, id: string): Partial<AppState> {
  const fileTabsByProject: Record<string, FileTab[]> = {};
  for (const [path, tabs] of Object.entries(state.fileTabsByProject)) {
    fileTabsByProject[path] = tabs.filter((t) => t.id !== id);
  }
  return {
    fileTabsByProject,
    activeTabByProject: reassignActive(
      state.activeTabByProject,
      id,
      state.sessions,
      state.plansTabsByProject,
      state.loopTabsByProject,
      state.agentTabsByProject,
      fileTabsByProject
    )
  };
}

function removePlansTab(state: AppState, id: string): Partial<AppState> {
  const plansTabsByProject: Record<string, PlansTab[]> = {};
  for (const [path, tabs] of Object.entries(state.plansTabsByProject)) {
    plansTabsByProject[path] = tabs.filter((t) => t.id !== id);
  }
  return {
    plansTabsByProject,
    activeTabByProject: reassignActive(
      state.activeTabByProject,
      id,
      state.sessions,
      plansTabsByProject,
      state.loopTabsByProject,
      state.agentTabsByProject,
      state.fileTabsByProject
    )
  };
}

function removeLoopTab(state: AppState, id: string): Partial<AppState> {
  const loopTabsByProject: Record<string, LoopTab[]> = {};
  for (const [path, tabs] of Object.entries(state.loopTabsByProject)) {
    loopTabsByProject[path] = tabs.filter((t) => t.id !== id);
  }
  return {
    loopTabsByProject,
    activeTabByProject: reassignActive(
      state.activeTabByProject,
      id,
      state.sessions,
      state.plansTabsByProject,
      loopTabsByProject,
      state.agentTabsByProject,
      state.fileTabsByProject
    )
  };
}

function removeAgentTab(state: AppState, id: string): Partial<AppState> {
  const agentTabsByProject: Record<string, AgentLauncherTab[]> = {};
  for (const [path, tabs] of Object.entries(state.agentTabsByProject)) {
    agentTabsByProject[path] = tabs.filter((t) => t.id !== id);
  }
  return {
    agentTabsByProject,
    activeTabByProject: reassignActive(
      state.activeTabByProject,
      id,
      state.sessions,
      state.plansTabsByProject,
      state.loopTabsByProject,
      agentTabsByProject,
      state.fileTabsByProject
    )
  };
}

/** Combined tabs (sessions + plans + loop runner + file tabs) of the currently open project. */
export function useProjectTabs(): ProjectTab[] {
  const sessions = useAppStore((s) => s.sessions);
  const fileTabsByProject = useAppStore((s) => s.fileTabsByProject);
  const plansTabsByProject = useAppStore((s) => s.plansTabsByProject);
  const loopTabsByProject = useAppStore((s) => s.loopTabsByProject);
  const agentTabsByProject = useAppStore((s) => s.agentTabsByProject);
  const project = useAppStore((s) => s.currentProject);
  return useMemo(() => {
    if (!project) {
      return [];
    }
    const sessionTabs: ProjectTab[] = sessions
      .filter((s) => s.projectPath === project.path)
      .map((session) => ({ id: session.id, type: "session", session }));
    const plansTabs: ProjectTab[] = (plansTabsByProject[project.path] ?? []).map((tab) => ({
      id: tab.id,
      type: "plans",
      title: tab.title
    }));
    const loopTabs: ProjectTab[] = (loopTabsByProject[project.path] ?? []).map((tab) => ({
      id: tab.id,
      type: "loops",
      title: tab.title
    }));
    const agentTabs: ProjectTab[] = (agentTabsByProject[project.path] ?? []).map((tab) => ({
      id: tab.id,
      type: "agent-launcher",
      title: tab.title
    }));
    const fileTabs: ProjectTab[] = (fileTabsByProject[project.path] ?? []).map((tab) => ({
      id: tab.id,
      type: "files",
      title: tab.title
    }));
    return [...sessionTabs, ...agentTabs, ...loopTabs, ...plansTabs, ...fileTabs];
  }, [sessions, fileTabsByProject, plansTabsByProject, loopTabsByProject, agentTabsByProject, project]);
}

export function useActiveTabId(): string | null {
  return useAppStore((s) =>
    s.currentProject ? (s.activeTabByProject[s.currentProject.path] ?? null) : null
  );
}
