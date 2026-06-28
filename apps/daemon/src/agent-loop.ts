import type { FastifyInstance } from "fastify";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type {
  AgentLoopRequest,
  AgentLoopResponse,
  AgentLoopStatus
} from "@orquester/api";
import type { Broadcaster } from "./broadcaster";
import type { SessionManager } from "./sessions";

const SCRIPTS_DIR =
  process.env.ORQUESTER_SCRIPTS_DIR && process.env.ORQUESTER_SCRIPTS_DIR.length > 0
    ? process.env.ORQUESTER_SCRIPTS_DIR
    : fileURLToPath(new URL("../../../scripts", import.meta.url));
const TURN_SCRIPT = join(SCRIPTS_DIR, "loop-chain-turn.sh");

const CHANNEL = "agent-loops";
const DONE_TOKEN = "<<LOOP_DONE>>";
/** Agents whose one-shot invocation loop-chain-turn.sh knows how to drive. */
const SUPPORTED_AGENTS = new Set(["claude", "codex"]);
const POLL_MS = 1000;
const TURN_TIMEOUT_MS = 60 * 60 * 1000; // 1h per turn

interface AgentLoopServices {
  sessions: SessionManager;
  broadcaster: Broadcaster;
}

interface RunningLoop {
  cancelled: boolean;
}

const loops = new Map<string, RunningLoop>();

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|\r/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && isAbsolute(value);
}

function batonHeader(task: string, agents: string[], maxRounds: number): string {
  return `# Orquester — Tarea en relevo entre agentes

Eres uno de varios agentes que se van pasando esta MISMA tarea por turnos.
Orden de relevo: ${agents.join(" → ")} (hasta ${maxRounds} vueltas).

## Cómo trabajar
1. Lee TODO este documento: la tarea y lo que han hecho los turnos anteriores.
2. Haz **el siguiente paso concreto** de la tarea (no rehagas lo ya hecho).
3. Aplica cambios reales en el código/archivos del directorio de trabajo.
4. Termina tu turno con un resumen BREVE de lo que hiciste y qué falta.
5. Si —y solo si— la tarea está COMPLETA y verificada, escribe en la última
   línea, tal cual, el token: ${DONE_TOKEN}
   (No lo escribas si aún queda trabajo: harías que el relevo pare antes de tiempo.)

## Tarea
${task.trim()}

---
`;
}

/** Drive one relay loop to completion. Runs detached from the HTTP request. */
async function driveLoop(
  services: AgentLoopServices,
  loopId: string,
  sessionId: string,
  workDir: string,
  agents: string[],
  maxRounds: number
): Promise<void> {
  const { sessions, broadcaster } = services;
  const loopDir = join(workDir, ".orquester-loop");
  const batonPath = join(loopDir, "baton.md");

  const publish = (status: AgentLoopStatus) =>
    broadcaster.publish(CHANNEL, status.state === "done" ? "agent-loop.done" : "agent-loop.turn", status);

  const finish = (reason: NonNullable<AgentLoopStatus["reason"]>, round: number, agent: string, message?: string) => {
    loops.delete(loopId);
    publish({ loopId, sessionId, round, agent, state: "done", reason, message });
  };

  const totalTurns = maxRounds * agents.length;

  for (let round = 0; round < totalTurns; round += 1) {
    const loop = loops.get(loopId);
    if (!loop || loop.cancelled) {
      finish("stopped", round, agents[round % agents.length] ?? "");
      return;
    }
    if (sessions.get(sessionId)?.status === "exited") {
      finish("stopped", round, agents[round % agents.length] ?? "", "La sesión del loop se cerró.");
      return;
    }

    const agent = agents[round % agents.length];
    const outFile = join(loopDir, `turn-${round}.out`);
    const doneFile = join(loopDir, `turn-${round}.done`);

    publish({ loopId, sessionId, round, agent, state: "running" });

    const command =
      [TURN_SCRIPT, workDir, agent, batonPath, outFile, doneFile, String(round)]
        .map((part) => JSON.stringify(part))
        .join(" ") + "\n";
    sessions.input(sessionId, command);

    const result = await waitForTurn(doneFile, loopId, sessionId, sessions);
    if (result !== "done") {
      finish(result === "cancelled" ? "stopped" : "error", round, agent, turnFailureMessage(result));
      return;
    }

    // Append this turn's output to the baton so the next agent sees it.
    const raw = await readFile(outFile, "utf8").catch(() => "");
    const clean = stripAnsi(raw).trim();
    await appendFileSafe(batonPath, `\n## Turno ${round + 1} — ${agent}\n\n${clean || "(sin salida)"}\n`);

    if (clean.includes(DONE_TOKEN)) {
      finish("completed", round, agent);
      return;
    }
  }

  finish("maxRounds", totalTurns, agents[(totalTurns - 1) % agents.length] ?? "");
}

type TurnResult = "done" | "cancelled" | "session-dead" | "timeout";

function turnFailureMessage(result: TurnResult): string | undefined {
  if (result === "session-dead") return "La sesión del loop se cerró durante el turno.";
  if (result === "timeout") return "El turno superó el tiempo máximo.";
  return undefined;
}

async function waitForTurn(
  doneFile: string,
  loopId: string,
  sessionId: string,
  sessions: SessionManager
): Promise<TurnResult> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  for (;;) {
    if (await fileExists(doneFile)) return "done";
    const loop = loops.get(loopId);
    if (!loop || loop.cancelled) return "cancelled";
    if (sessions.get(sessionId)?.status === "exited") return "session-dead";
    if (Date.now() > deadline) return "timeout";
    await delay(POLL_MS);
  }
}

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

async function appendFileSafe(path: string, text: string): Promise<void> {
  const current = await readFile(path, "utf8").catch(() => "");
  await writeFile(path, current + text, "utf8");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerAgentLoopRoutes(app: FastifyInstance, services: AgentLoopServices): void {
  const { sessions, broadcaster } = services;

  app.post<{ Body: AgentLoopRequest }>(
    "/api/agent-loops",
    async (request, reply): Promise<AgentLoopResponse | void> => {
      const body = request.body ?? ({} as AgentLoopRequest);
      const { path, task, agents, maxRounds, projectPath } = body;

      if (!isAbsolutePath(path)) {
        return reply.code(400).send({ code: "INVALID_PATH", message: "path must be an absolute path." });
      }
      if (typeof task !== "string" || task.trim().length === 0) {
        return reply.code(400).send({ code: "INVALID_TASK", message: "task is required." });
      }
      if (!Array.isArray(agents) || agents.length === 0 || !agents.every((a) => SUPPORTED_AGENTS.has(a))) {
        return reply
          .code(400)
          .send({ code: "INVALID_AGENTS", message: "agents must be a non-empty list of 'claude' or 'codex'." });
      }
      const rounds = Number.isFinite(maxRounds) && maxRounds > 0 ? Math.min(Math.floor(maxRounds), 50) : 1;

      if (!(await fileExists(path))) {
        return reply.code(400).send({ code: "PATH_NOT_FOUND", message: `Path does not exist: ${path}` });
      }

      const loopId = randomUUID();
      const loopDir = join(path, ".orquester-loop");
      const batonPath = join(loopDir, "baton.md");
      try {
        await mkdir(loopDir, { recursive: true });
        await writeFile(batonPath, batonHeader(task, agents, rounds), "utf8");
      } catch (error) {
        return reply.code(500).send({
          code: "LOOP_SETUP_ERROR",
          message: error instanceof Error ? error.message : "Failed to prepare loop."
        });
      }

      const session = sessions.create({
        kind: "shell",
        refId: "bash",
        projectPath: projectPath ?? path,
        cwd: path,
        cols: 120,
        rows: 40,
        title: `Agent Loop · ${agents.join("→")}`
      });

      loops.set(loopId, { cancelled: false });
      broadcaster.publish(CHANNEL, "agent-loop.started", {
        loopId,
        sessionId: session.id,
        path,
        agents,
        maxRounds: rounds
      });

      // Drive the relay in the background; progress streams over CHANNEL.
      void driveLoop(services, loopId, session.id, path, agents, rounds);

      const response: AgentLoopResponse = {
        ok: true,
        loopId,
        sessionId: session.id,
        path,
        agents,
        maxRounds: rounds,
        batonPath
      };
      return response;
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/agent-loops/:id/stop",
    async (request): Promise<{ ok: true }> => {
      const loop = loops.get(request.params.id);
      if (loop) {
        loop.cancelled = true;
      }
      return { ok: true };
    }
  );
}
