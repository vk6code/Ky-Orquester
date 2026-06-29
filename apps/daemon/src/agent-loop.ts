import type { FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type {
  AgentLoopParticipant,
  AgentLoopRequest,
  AgentLoopResponse,
  AgentLoopStatus
} from "@orquester/api";
import type { Broadcaster } from "./broadcaster";
import type { SessionManager } from "./sessions";

const execFileAsync = promisify(execFile);

const SCRIPTS_DIR =
  process.env.ORQUESTER_SCRIPTS_DIR && process.env.ORQUESTER_SCRIPTS_DIR.length > 0
    ? process.env.ORQUESTER_SCRIPTS_DIR
    : fileURLToPath(new URL("../../../scripts", import.meta.url));
const TURN_SCRIPT = join(SCRIPTS_DIR, "loop-chain-turn.sh");

const CHANNEL = "agent-loops";
const DONE_TOKEN = "<<LOOP_DONE>>";
/** Agents whose one-shot invocation loop-chain-turn.sh knows how to drive. */
const SUPPORTED_AGENTS = new Set(["claude", "codex", "opencode", "kimi", "pi", "gemini"]);
const POLL_MS = 1000;
const TURN_TIMEOUT_MS = 60 * 60 * 1000; // 1h per turn
/** Cap how much of a turn's output we fold back into the baton. */
const MAX_HANDOFF_CHARS = 8000;

interface AgentLoopServices {
  sessions: SessionManager;
  broadcaster: Broadcaster;
  /** Base folder for per-loop work dirs (outside any project). */
  loopsDir: string;
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

function participantLabel(p: AgentLoopParticipant): string {
  return p.role ? `${p.agent} (${p.role})` : p.agent;
}

function batonHeader(task: string, participants: AgentLoopParticipant[], maxRounds: number): string {
  const roster = participants.map((p, i) => `${i + 1}. ${participantLabel(p)}`).join("\n");
  return `# Orquester — Tarea en relevo entre agentes

Sois un equipo de agentes que os pasáis esta MISMA tarea por turnos, en este orden
(hasta ${maxRounds} vueltas):
${roster}

Trabajáis sobre el código real del proyecto (vuestro directorio de trabajo). Las
notas de coordinación (este documento y los relevos) las gestiona Orquester aparte.

## Tarea
${task.trim()}

---
`;
}

/** The per-turn prompt fed to the acting agent: baton + its role/skill + protocol. */
function composeTurnPrompt(
  baton: string,
  participant: AgentLoopParticipant,
  handoffFile: string,
  round: number
): string {
  const role = participant.role?.trim();
  const skill = participant.skill?.trim();
  return `${baton}

---
## TU TURNO (turno ${round + 1})
- Agente: ${participant.agent}
${role ? `- Rol: ${role}\n` : ""}${skill ? `- Skill / instrucciones: ${skill}\n` : ""}
Haz **el siguiente paso concreto** de la tarea según tu rol (no rehagas lo ya hecho).
Aplica los cambios reales en el código del proyecto.

Al terminar, escribe tu RELEVO para el siguiente agente en este fichero:
  ${handoffFile}
con el formato:
  ## Resumen
  (qué hiciste)
  ## Archivos tocados
  (lista)
  ## Siguiente paso
  (qué debe hacer el siguiente)
  STATUS: CONTINUE

Si —y solo si— la tarea está COMPLETA y verificada, pon \`STATUS: DONE\` en vez de
CONTINUE (y opcionalmente escribe ${DONE_TOKEN} al final de tu respuesta). No pongas
DONE si queda trabajo: pararías el relevo antes de tiempo.
`;
}

async function isGitRepo(dir: string): Promise<boolean> {
  return execFileAsync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
}

/** Commit all project changes as a turn snapshot. Returns the short hash or null. */
async function gitSnapshot(dir: string, message: string): Promise<string | null> {
  try {
    await execFileAsync("git", ["-C", dir, "add", "-A"], { timeout: 30_000 });
    await execFileAsync("git", ["-C", dir, "commit", "-m", message, "--no-verify"], {
      timeout: 30_000
    });
    const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], {
      timeout: 10_000
    });
    return stdout.trim();
  } catch {
    // Nothing to commit, or not a repo — not fatal.
    return null;
  }
}

/** Drive one relay loop to completion. Runs detached from the HTTP request. */
async function driveLoop(
  services: AgentLoopServices,
  loopId: string,
  sessionId: string,
  projectDir: string,
  participants: AgentLoopParticipant[],
  maxRounds: number,
  snapshot: boolean
): Promise<void> {
  const { sessions, broadcaster } = services;
  const loopDir = join(services.loopsDir, loopId);
  const batonPath = join(loopDir, "baton.md");

  const publish = (status: AgentLoopStatus) =>
    broadcaster.publish(CHANNEL, status.state === "done" ? "agent-loop.done" : "agent-loop.turn", status);

  const finish = (
    reason: NonNullable<AgentLoopStatus["reason"]>,
    round: number,
    p: AgentLoopParticipant | undefined,
    message?: string
  ) => {
    loops.delete(loopId);
    publish({
      loopId,
      sessionId,
      round,
      agent: p?.agent ?? "",
      role: p?.role,
      state: "done",
      reason,
      message
    });
  };

  const totalTurns = maxRounds * participants.length;

  for (let round = 0; round < totalTurns; round += 1) {
    const loop = loops.get(loopId);
    const participant = participants[round % participants.length];
    if (!loop || loop.cancelled) {
      finish("stopped", round, participant);
      return;
    }
    if (sessions.get(sessionId)?.status === "exited") {
      finish("stopped", round, participant, "La sesión del loop se cerró.");
      return;
    }

    const promptFile = join(loopDir, `prompt-${round}.md`);
    const handoffFile = join(loopDir, `handoff-${round}.md`);
    const outFile = join(loopDir, `out-${round}.txt`);
    const doneFile = join(loopDir, `done-${round}`);

    const baton = await readFile(batonPath, "utf8").catch(() => "");
    await writeFile(promptFile, composeTurnPrompt(baton, participant, handoffFile, round), "utf8");

    publish({ loopId, sessionId, round, agent: participant.agent, role: participant.role, state: "running" });

    const command =
      [TURN_SCRIPT, projectDir, participant.agent, promptFile, outFile, doneFile, String(round)]
        .map((part) => JSON.stringify(part))
        .join(" ") + "\n";
    sessions.input(sessionId, command);

    const result = await waitForTurn(doneFile, loopId, sessionId, sessions);
    if (result !== "done") {
      finish(result === "cancelled" ? "stopped" : "error", round, participant, turnFailureMessage(result));
      return;
    }

    // Prefer the structured handoff the agent wrote; fall back to its stdout.
    const handoff = (await readFile(handoffFile, "utf8").catch(() => "")).trim();
    const out = stripAnsi(await readFile(outFile, "utf8").catch(() => "")).trim();
    const entry = (handoff || out || "(sin salida)").slice(0, MAX_HANDOFF_CHARS);
    await appendFileSafe(
      batonPath,
      `\n## Turno ${round + 1} — ${participantLabel(participant)}\n\n${entry}\n`
    );

    if (snapshot) {
      const hash = await gitSnapshot(
        projectDir,
        `orquester loop ${loopId.slice(0, 8)} · turno ${round + 1} (${participantLabel(participant)})`
      );
      if (hash) {
        await appendFileSafe(batonPath, `\n_(snapshot git: ${hash})_\n`);
      }
    }

    const done = /STATUS:\s*DONE/i.test(handoff) || handoff.includes(DONE_TOKEN) || out.includes(DONE_TOKEN);
    if (done) {
      finish("completed", round, participant);
      return;
    }
  }

  finish("maxRounds", totalTurns, participants[(totalTurns - 1) % participants.length]);
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

function validParticipants(value: unknown): value is AgentLoopParticipant[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (p) =>
        p &&
        typeof p === "object" &&
        SUPPORTED_AGENTS.has((p as AgentLoopParticipant).agent) &&
        ((p as AgentLoopParticipant).role === undefined ||
          typeof (p as AgentLoopParticipant).role === "string") &&
        ((p as AgentLoopParticipant).skill === undefined ||
          typeof (p as AgentLoopParticipant).skill === "string")
    )
  );
}

export function registerAgentLoopRoutes(app: FastifyInstance, services: AgentLoopServices): void {
  const { sessions, broadcaster } = services;

  app.post<{ Body: AgentLoopRequest }>(
    "/api/agent-loops",
    async (request, reply): Promise<AgentLoopResponse | void> => {
      const body = request.body ?? ({} as AgentLoopRequest);
      const { path, task, participants, maxRounds, projectPath } = body;

      if (!isAbsolutePath(path)) {
        return reply.code(400).send({ code: "INVALID_PATH", message: "path must be an absolute path." });
      }
      if (typeof task !== "string" || task.trim().length === 0) {
        return reply.code(400).send({ code: "INVALID_TASK", message: "task is required." });
      }
      if (!validParticipants(participants)) {
        return reply.code(400).send({
          code: "INVALID_PARTICIPANTS",
          message: `participants must be a non-empty list of { agent, role?, skill? } with agent one of: ${[...SUPPORTED_AGENTS].join(", ")}.`
        });
      }
      const rounds = Number.isFinite(maxRounds) && maxRounds > 0 ? Math.min(Math.floor(maxRounds), 50) : 1;

      if (!(await fileExists(path))) {
        return reply.code(400).send({ code: "PATH_NOT_FOUND", message: `Path does not exist: ${path}` });
      }

      const snapshot = body.gitSnapshot === true && (await isGitRepo(path));

      const loopId = randomUUID();
      const loopDir = join(services.loopsDir, loopId);
      const batonPath = join(loopDir, "baton.md");
      try {
        await mkdir(loopDir, { recursive: true });
        await writeFile(batonPath, batonHeader(task, participants, rounds), "utf8");
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
        title: `Agent Loop · ${participants.map((p) => p.agent).join("→")}`
      });

      loops.set(loopId, { cancelled: false });
      broadcaster.publish(CHANNEL, "agent-loop.started", {
        loopId,
        sessionId: session.id,
        path,
        participants,
        maxRounds: rounds
      });

      // Drive the relay in the background; progress streams over CHANNEL.
      void driveLoop(services, loopId, session.id, path, participants, rounds, snapshot);

      const response: AgentLoopResponse = {
        ok: true,
        loopId,
        sessionId: session.id,
        path,
        participants,
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
