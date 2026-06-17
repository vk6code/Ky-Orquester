import type { ClientConfig, DaemonConfig } from "@orquester/config";

export type RuntimeMode = "desktop-local" | "desktop-remote" | "web-remote";

export interface ApiEnvelope<T> {
  data: T;
}

export interface ApiErrorPayload {
  code: string;
  message: string;
}

export interface HealthResponse {
  ok: true;
  daemonId: string;
  version: string;
  mode: "local" | "remote";
  transports: Array<"unix" | "http">;
}

export interface ServerInfoResponse {
  name: string;
  dataDir: string;
  workspacesDir: string;
  capabilities: {
    terminals: boolean;
    sessions: boolean;
    agents: boolean;
    docker: boolean;
  };
}

/**
 * A workspace is a top-level directory inside the daemon `workspacesDir`.
 * `(workspacesDir)/<name>` => workspace "name".
 */
export interface WorkspaceSummary {
  name: string;
  path: string;
  projectCount: number;
}

/**
 * A project is a sub-directory of a workspace directory.
 * `(workspacesDir)/<workspace>/<name>` => project "name".
 */
export interface ProjectSummary {
  name: string;
  workspace: string;
  path: string;
}

export interface CreateWorkspaceRequest {
  name: string;
}

export interface CreateProjectRequest {
  name: string;
}

/** A pluggable coding agent the daemon detected on the host. */
export interface AgentSummary {
  id: string;
  name: string;
  installed: boolean;
  version?: string;
}

/** An editor/IDE or OS tool a project folder can be opened with. */
export interface OpenTargetSummary {
  id: string;
  name: string;
  kind: "ide" | "explorer" | "terminal";
  available: boolean;
}

// ---------------------------------------------------------------------------
// Registry — shells & agents share the same shape.
// ---------------------------------------------------------------------------

export type RegistryKind = "shell" | "agent";

export interface RegistryEntry {
  id: string;
  name: string;
  kind: RegistryKind;
  /** Candidate binaries; the first found in PATH wins (cached by the daemon). */
  bin: string[];
  /** True only when a candidate bin resolved AND the entry is not disabled. */
  enabled: boolean;
  /** Absolute path of the resolved bin, when found. */
  resolvedBin?: string;
  /** Flag to print a version (agents only), e.g. "--version". */
  versionFlag?: string;
  /** Shell command to install the bin (agents only). */
  installCmd?: string;
  /** Shell command to update the bin (agents only). */
  updateCmd?: string;
}

export interface RegistryResponse {
  shells: RegistryEntry[];
  agents: RegistryEntry[];
}

export interface RegistryActionResult {
  ok: boolean;
  exitCode: number;
  output: string;
}

// ---------------------------------------------------------------------------
// Sessions — a live PTY (shell or agent) owned by the daemon. Open sessions
// for a project are that project's tabs; they outlive client disconnects.
// ---------------------------------------------------------------------------

export type SessionStatus = "running" | "exited";

export interface SessionSummary {
  id: string;
  kind: RegistryKind;
  /** Registry entry id this session was launched from (e.g. "bash", "claude"). */
  refId: string;
  title: string;
  /** Project the tab belongs to ("" = not bound to a project). */
  projectPath: string;
  cwd: string;
  cols: number;
  rows: number;
  status: SessionStatus;
  exitCode?: number;
  createdAt: string;
}

export interface CreateSessionRequest {
  kind: RegistryKind;
  refId: string;
  projectPath?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  title?: string;
}

export interface SessionInputRequest {
  data: string;
}

export interface SessionResizeRequest {
  cols: number;
  rows: number;
}

/** Frames pushed from daemon to client over the session stream. */
export type SessionStreamMessage =
  | { type: "buffer"; data: string }
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number };

/** Frames sent from client to daemon over the session stream. */
export type SessionInputMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export interface EventMessage<TPayload = unknown> {
  id: string;
  channel: string;
  type: string;
  createdAt: string;
  payload: TPayload;
}

export interface SubscriptionRequest {
  channels: string[];
}

export interface OrquesterApi {
  health(): Promise<HealthResponse>;
  info(): Promise<ServerInfoResponse>;
  daemonConfig(): Promise<DaemonConfig>;
  clientConfig(): Promise<ClientConfig>;
  listWorkspaces(): Promise<WorkspaceSummary[]>;
  listProjects(workspace: string): Promise<ProjectSummary[]>;
}

export interface HttpApiClientOptions {
  baseUrl: string;
  password?: string;
  fetch?: typeof fetch;
}

export class HttpOrquesterApiClient implements OrquesterApi {
  private readonly baseUrl: string;
  private readonly password?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.password = options.password;
    this.fetchImpl = options.fetch ?? fetch;
  }

  health(): Promise<HealthResponse> {
    return this.get("/health");
  }

  info(): Promise<ServerInfoResponse> {
    return this.get("/api/info");
  }

  daemonConfig(): Promise<DaemonConfig> {
    return this.get("/api/config/daemon");
  }

  clientConfig(): Promise<ClientConfig> {
    return this.get("/api/config/client");
  }

  listWorkspaces(): Promise<WorkspaceSummary[]> {
    return this.get("/api/workspaces");
  }

  listProjects(workspace: string): Promise<ProjectSummary[]> {
    return this.get(`/api/workspaces/${encodeURIComponent(workspace)}/projects`);
  }

  eventsUrl(): string {
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/events";
    return url.toString();
  }

  private async get<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: this.authHeaders()
    });

    if (!response.ok) {
      throw new Error(`Orquester API request failed: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  private authHeaders(): HeadersInit {
    if (!this.password) {
      return {};
    }

    return {
      Authorization: `Bearer ${this.password}`
    };
  }
}
