import type {
  AgentLoopRefineRequest,
  AgentLoopRefineResponse,
  AgentLoopRequest,
  AgentLoopResponse,
  AgentSkill,
  AgentSummary,
  AuthInfoResponse,
  CreateProjectRequest,
  CreateSessionRequest,
  CreateWorkspaceRequest,
  EventMessage,
  FsListResponse,
  FsReadResponse,
  HealthResponse,
  LoopRunRequest,
  LoopRunResponse,
  OpenResult,
  OpenTargetSummary,
  ProjectSummary,
  RegistryActionResult,
  RegistryResponse,
  ServerInfoResponse,
  SessionSummary,
  WorkspaceSummary
} from "@orquester/api";
import type { AppConfig, DaemonConfig, LoopBlock, RemoteConnectionConfig } from "@orquester/config";
import type { Gorila360LoopRunRequest, Gorila360LoopRunResponse, Gorila360PlanSummary, UiConnection } from "../types";
import type {
  StreamHandle,
  StreamHandlers,
  Transporter,
  TransportMethod,
  TransportRequest
} from "./transporter";

export interface ApiRequestOptions {
  query?: TransportRequest["query"];
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * ApiClient is the "server manager": it owns the active {@link UiConnection}
 * and its {@link Transporter}, and exposes typed daemon endpoints to the
 * services/hooks above it. It does not know or care which transport is in use.
 *
 * NOTE: skeleton — endpoints are wired but no client-side logic/caching yet.
 */
export class ApiClient {
  constructor(
    public readonly connection: UiConnection,
    private readonly transporter: Transporter
  ) { }

  get transportKind(): string {
    return this.transporter.kind;
  }

  /** Low-level escape hatch for endpoints not yet wrapped below. */
  async send<T>(method: TransportMethod, path: string, options: ApiRequestOptions = {}): Promise<T> {
    const response = await this.transporter.request<T>({
      method,
      path,
      query: options.query,
      body: options.body,
      signal: options.signal
    });

    if (!response.ok) {
      throw new ApiError(response.status, method, path);
    }

    return response.data;
  }

  /**
   * Subscribe to the daemon event bus (NDJSON). `onEnd` fires when the stream
   * closes (e.g. the transport restarted) — used to detect disconnects.
   * Returns an unsubscribe fn.
   */
  openEvents(onEvent: (event: EventMessage) => void, onEnd?: () => void): () => void {
    let buffer = "";
    const handle = this.transporter.openStream("/events", {
      onData: (chunk) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim()) {
            try {
              onEvent(JSON.parse(line) as EventMessage);
            } catch {
              /* ignore malformed line */
            }
          }
          newline = buffer.indexOf("\n");
        }
      },
      onEnd: () => onEnd?.()
    });
    return () => handle.close();
  }

  // Daemon meta

  health(signal?: AbortSignal): Promise<HealthResponse> {
    return this.send("GET", "/health", { signal });
  }

  info(signal?: AbortSignal): Promise<ServerInfoResponse> {
    return this.send("GET", "/api/info", { signal });
  }

  /** Public auth metadata (whether a token is required + bcrypt salt to derive it). */
  authInfo(signal?: AbortSignal): Promise<AuthInfoResponse> {
    return this.send("GET", "/api/auth/info", { signal });
  }

  getDaemonConfig(signal?: AbortSignal): Promise<DaemonConfig> {
    return this.send("GET", "/api/config/daemon", { signal });
  }

  /** Update daemon.json. Daemon rejects this (403) over the remote HTTP transport. */
  updateDaemonConfig(patch: Partial<DaemonConfig>): Promise<DaemonConfig> {
    return this.send("PUT", "/api/config/daemon", { body: patch });
  }

  // --- App config + remote servers (shared, daemon-persisted) --------------

  getAppConfig(signal?: AbortSignal): Promise<AppConfig> {
    return this.send("GET", "/api/config/app", { signal });
  }

  updateAppConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
    return this.send("PUT", "/api/config/app", { body: patch });
  }

  listRemotes(signal?: AbortSignal): Promise<RemoteConnectionConfig[]> {
    return this.send("GET", "/api/config/remotes", { signal });
  }

  saveRemotes(remotes: RemoteConnectionConfig[]): Promise<RemoteConnectionConfig[]> {
    return this.send("PUT", "/api/config/remotes", { body: remotes });
  }

  // Display-only labels for workspaces/projects, keyed by absolute path.
  listLabels(signal?: AbortSignal): Promise<Record<string, string>> {
    return this.send("GET", "/api/config/labels", { signal });
  }

  saveLabels(labels: Record<string, string>): Promise<Record<string, string>> {
    return this.send("PUT", "/api/config/labels", { body: labels });
  }

  // Workspace/project paths hidden from the sidebar (disk untouched).
  listHidden(signal?: AbortSignal): Promise<string[]> {
    return this.send("GET", "/api/config/hidden", { signal });
  }

  saveHidden(paths: string[]): Promise<string[]> {
    return this.send("PUT", "/api/config/hidden", { body: paths });
  }

  // Workspaces & projects (filesystem-backed)

  listWorkspaces(signal?: AbortSignal): Promise<WorkspaceSummary[]> {
    return this.send("GET", "/api/workspaces", { signal });
  }

  createWorkspace(req: CreateWorkspaceRequest, signal?: AbortSignal): Promise<WorkspaceSummary> {
    return this.send("POST", "/api/workspaces", { body: req, signal });
  }

  listProjects(workspace: string, signal?: AbortSignal): Promise<ProjectSummary[]> {
    return this.send("GET", `/api/workspaces/${encodeURIComponent(workspace)}/projects`, { signal });
  }

  // --- File browser --------------------------------------------------------

  listFiles(path: string, signal?: AbortSignal): Promise<FsListResponse> {
    return this.send("GET", "/api/fs", { query: { path }, signal });
  }

  readFile(path: string, signal?: AbortSignal): Promise<FsReadResponse> {
    return this.send("GET", "/api/fs/read", { query: { path }, signal });
  }

  createFsEntry(path: string, kind: "file" | "dir"): Promise<{ ok: true }> {
    return this.send("POST", "/api/fs/create", { body: { path, kind } });
  }

  saveFile(path: string, content: string): Promise<{ ok: true }> {
    return this.send("PUT", "/api/fs/write", { body: { path, content } });
  }

  createProject(
    workspace: string,
    req: CreateProjectRequest,
    signal?: AbortSignal
  ): Promise<ProjectSummary> {
    return this.send("POST", `/api/workspaces/${encodeURIComponent(workspace)}/projects`, {
      body: req,
      signal
    });
  }

  // Catalog (agents / open targets)

  listAgents(signal?: AbortSignal): Promise<AgentSummary[]> {
    return this.send("GET", "/api/agents", { signal });
  }

  listOpenTargets(signal?: AbortSignal): Promise<OpenTargetSummary[]> {
    return this.send("GET", "/api/open-targets", { signal });
  }

  // Registry (shells & agents)

  listRegistry(signal?: AbortSignal): Promise<RegistryResponse> {
    return this.send("GET", "/api/registry", { signal });
  }

  installRegistryEntry(id: string): Promise<RegistryActionResult> {
    return this.send("POST", `/api/registry/${encodeURIComponent(id)}/install`);
  }

  updateRegistryEntry(id: string): Promise<RegistryActionResult> {
    return this.send("POST", `/api/registry/${encodeURIComponent(id)}/update`);
  }

  registryVersion(id: string): Promise<RegistryActionResult> {
    return this.send("GET", `/api/registry/${encodeURIComponent(id)}/version`);
  }

  /** Launch an ide/file-explorer/browser target on a path. */
  open(targetId: string, path: string): Promise<OpenResult> {
    return this.send("POST", "/api/open", { body: { targetId, path } });
  }

  // Sessions (PTYs)

  listSessions(projectPath?: string, signal?: AbortSignal): Promise<SessionSummary[]> {
    return this.send("GET", "/api/sessions", {
      query: projectPath ? { projectPath } : undefined,
      signal
    });
  }

  createSession(req: CreateSessionRequest): Promise<SessionSummary> {
    return this.send("POST", "/api/sessions", { body: req });
  }

  closeSession(id: string): Promise<void> {
    return this.send("DELETE", `/api/sessions/${encodeURIComponent(id)}`);
  }

  sendSessionInput(id: string, data: string): Promise<void> {
    return this.send("POST", `/api/sessions/${encodeURIComponent(id)}/input`, { body: { data } });
  }

  resizeSession(id: string, cols: number, rows: number): Promise<void> {
    return this.send("POST", `/api/sessions/${encodeURIComponent(id)}/resize`, {
      body: { cols, rows }
    });
  }

  /** Open the live output stream for a session (buffer replay + live bytes). */
  openSessionOutput(id: string, handlers: StreamHandlers): StreamHandle {
    return this.transporter.openStream(`/api/sessions/${encodeURIComponent(id)}/output`, handlers);
  }

  // Gorila360 integration

  listGorila360Plans(signal?: AbortSignal): Promise<Gorila360PlanSummary[]> {
    return this.send("GET", "/api/gorila360/plans", { signal });
  }

  runLoop(req: LoopRunRequest): Promise<LoopRunResponse> {
    return this.send("POST", "/api/loops", { body: req });
  }

  runGorila360Loop(req: Gorila360LoopRunRequest): Promise<Gorila360LoopRunResponse> {
    return this.send("POST", "/api/gorila360/loops", { body: req });
  }

  // Multi-agent relay loop: hand a task between agents in turn.
  startAgentLoop(req: AgentLoopRequest): Promise<AgentLoopResponse> {
    return this.send("POST", "/api/agent-loops", { body: req });
  }

  stopAgentLoop(loopId: string): Promise<{ ok: true }> {
    return this.send("POST", `/api/agent-loops/${encodeURIComponent(loopId)}/stop`, {});
  }

  refineLoopPrompt(req: AgentLoopRefineRequest): Promise<AgentLoopRefineResponse> {
    return this.send("POST", "/api/agent-loops/refine", { body: req });
  }

  // Reusable code-folder blocks for the relay loop runner.
  listLoopBlocks(signal?: AbortSignal): Promise<LoopBlock[]> {
    return this.send("GET", "/api/config/loop-blocks", { signal });
  }

  saveLoopBlocks(blocks: LoopBlock[]): Promise<LoopBlock[]> {
    return this.send("PUT", "/api/config/loop-blocks", { body: blocks });
  }

  // Skills installed for a code agent (for the per-participant skill picker).
  listAgentSkills(agentId: string, signal?: AbortSignal): Promise<AgentSkill[]> {
    return this.send("GET", `/api/agents/${encodeURIComponent(agentId)}/skills`, { signal });
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    method: string,
    path: string
  ) {
    super(`Orquester API ${method} ${path} failed with status ${status}`);
    this.name = "ApiError";
  }
}
