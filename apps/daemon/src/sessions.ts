import type { CreateSessionRequest, SessionSummary } from "@orquester/api";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { spawn, type IPty } from "node-pty";
import type { RegistryService } from "./registry";

/** Cap the replay buffer so long-lived sessions don't grow unbounded. */
const MAX_BUFFER = 256 * 1024;

interface Session {
  summary: SessionSummary;
  pty: IPty | null;
  buffer: string;
  emitter: EventEmitter;
  /** Epoch ms of the last input or output byte; drives idle reaping. */
  lastActivityAt: number;
}

export class SessionError extends Error {}

/**
 * Owns every live PTY. Sessions outlive client connections: output is buffered
 * so a (re)connecting client gets the current screen, and lifecycle changes are
 * emitted on {@link lifecycle} for cross-client sync. Open sessions for a
 * project are that project's tabs.
 */
export class SessionManager {
  private sessions = new Map<string, Session>();
  /** Emits "created" | "exited" (SessionSummary) and "closed" ({ id }). */
  readonly lifecycle = new EventEmitter();

  constructor(private readonly registry: RegistryService) {}

  create(req: CreateSessionRequest): SessionSummary {
    const entry = this.registry.get(req.refId);
    if (!entry?.resolvedBin || !entry.enabled) {
      throw new SessionError(`Registry entry "${req.refId}" is not available.`);
    }

    const cols = req.cols && req.cols > 0 ? req.cols : 80;
    const rows = req.rows && req.rows > 0 ? req.rows : 24;
    const cwd = req.cwd || req.projectPath || homedir();
    const id = randomUUID();

    // Extra working directories (e.g. frontend + backend). Attached only when the
    // agent declares an addDirFlag (Claude Code: "--add-dir"); otherwise ignored.
    const extraDirs = (req.extraDirs ?? [])
      .filter((dir): dir is string => typeof dir === "string" && dir.trim().length > 0)
      .map((dir) => dir.trim());
    const args =
      entry.addDirFlag && extraDirs.length > 0
        ? extraDirs.flatMap((dir) => [entry.addDirFlag as string, dir])
        : [];

    const pty = spawn(entry.resolvedBin, args, {
      name: "xterm-256color",
      cwd,
      cols,
      rows,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" }
    });

    const summary: SessionSummary = {
      id,
      kind: entry.kind,
      refId: entry.id,
      title: req.title || entry.name,
      projectPath: req.projectPath ?? "",
      cwd,
      cols,
      rows,
      status: "running",
      createdAt: new Date().toISOString(),
      ...(extraDirs.length > 0 ? { extraDirs } : {})
    };

    const session: Session = {
      summary,
      pty,
      buffer: "",
      emitter: new EventEmitter(),
      lastActivityAt: Date.now()
    };
    this.sessions.set(id, session);

    pty.onData((data) => {
      session.lastActivityAt = Date.now();
      session.buffer = (session.buffer + data).slice(-MAX_BUFFER);
      session.emitter.emit("output", data);
    });
    pty.onExit(({ exitCode }) => {
      session.summary.status = "exited";
      session.summary.exitCode = exitCode;
      session.pty = null;
      session.emitter.emit("exit", exitCode);
      this.lifecycle.emit("exited", { ...session.summary });
    });

    this.lifecycle.emit("created", { ...summary });
    return { ...summary };
  }

  list(projectPath?: string): SessionSummary[] {
    const all = [...this.sessions.values()].map((s) => ({ ...s.summary }));
    return projectPath === undefined ? all : all.filter((s) => s.projectPath === projectPath);
  }

  get(id: string): SessionSummary | undefined {
    const session = this.sessions.get(id);
    return session ? { ...session.summary } : undefined;
  }

  buffer(id: string): string {
    return this.sessions.get(id)?.buffer ?? "";
  }

  input(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (session?.pty) {
      session.lastActivityAt = Date.now();
      session.pty.write(data);
    }
  }

  /**
   * Kill and forget every session with no input/output for longer than
   * `maxIdleMs`. Returns the reaped ids. Each reap emits "closed" via
   * {@link close}, so connected clients drop the tab.
   */
  reapIdle(maxIdleMs: number): string[] {
    const cutoff = Date.now() - maxIdleMs;
    const stale = [...this.sessions.values()]
      .filter((s) => s.lastActivityAt < cutoff)
      .map((s) => s.summary.id);
    for (const id of stale) {
      this.close(id);
    }
    return stale;
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (session?.pty && cols > 0 && rows > 0) {
      session.pty.resize(cols, rows);
      session.summary.cols = cols;
      session.summary.rows = rows;
    }
  }

  /** Kill (if running) and forget a session. Returns false if unknown. */
  close(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }
    try {
      session.pty?.kill();
    } catch {
      /* already gone */
    }
    this.sessions.delete(id);
    this.lifecycle.emit("closed", { id });
    return true;
  }

  /** Stream a session's output/exit to one client. Returns an unsubscribe fn. */
  subscribe(
    id: string,
    onOutput: (data: string) => void,
    onExit: (code: number) => void
  ): () => void {
    const session = this.sessions.get(id);
    if (!session) {
      return () => undefined;
    }
    session.emitter.on("output", onOutput);
    session.emitter.on("exit", onExit);
    return () => {
      session.emitter.off("output", onOutput);
      session.emitter.off("exit", onExit);
    };
  }

  /** Kill everything (daemon shutdown). */
  closeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.close(id);
    }
  }
}
