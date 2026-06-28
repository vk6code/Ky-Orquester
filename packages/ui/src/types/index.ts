import type {
  AgentSummary,
  EventMessage,
  OpenTargetSummary,
  ProjectSummary,
  RegistryEntry,
  RegistryKind,
  RegistryResponse,
  SessionStatus,
  SessionSummary,
  WorkspaceSummary
} from "@orquester/api";

export type Runtime = "desktop" | "web";

export type ConnectionKind = "local" | "remote";

export type ConnectionStatus = "connected" | "connecting" | "disconnected" | "error";

/**
 * A daemon connection as the UI understands it. The `endpoint` is transport
 * agnostic: `unix:///path/to/daemon.sock` for a local socket or
 * `http(s)://host:port` for a remote daemon.
 */
export interface UiConnection {
  id: string;
  name: string;
  kind: ConnectionKind;
  endpoint: string;
  status: ConnectionStatus;
  /** Bearer token for authenticated (remote/http) daemons. */
  password?: string;
}

export interface Gorila360PlanSummary {
  id: string;
  name: string;
  filename: string;
  path: string;
  updatedAt: string;
}

export type Gorila360LoopRunRequest = {
  repo: "backend" | "frontend";
  branch: string;
  planPath: string;
  phase: string;
  agent?: "claude" | "codex";
  projectPath?: string;
};

export interface Gorila360LoopRunResponse {
  ok: true;
  repo: string;
  branch: string;
  phase: string;
  agent: string;
  projectPath: string;
  worktree: string;
  sessionId: string;
  outputUrl: string;
}

export type {
  AgentSummary,
  EventMessage,
  OpenTargetSummary,
  ProjectSummary,
  RegistryEntry,
  RegistryKind,
  RegistryResponse,
  SessionStatus,
  SessionSummary,
  WorkspaceSummary,
  LoopRunRequest,
  LoopRunResponse,
  LoopTargetKind,
  LoopTargetSpec
} from "@orquester/api";
