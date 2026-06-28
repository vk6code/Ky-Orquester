import type { FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { Broadcaster } from "./broadcaster";
import type { SessionManager } from "./sessions";

const execFileAsync = promisify(execFile);

const GORILA360_ROOT = "/Users/victor/Documents/gorila360";
const ORQUESTER_SCRIPTS = "/Users/victor/Documents/orquester/orquester/scripts";
const WORKTREE_SCRIPT = `${ORQUESTER_SCRIPTS}/gorila360-worktree.sh`;
const LOOP_AGENT_SCRIPT = `${ORQUESTER_SCRIPTS}/loop-run-agent.sh`;

type Gorila360Repo = "backend" | "frontend";
type Gorila360Agent = "claude" | "codex";
type Gorila360Pipeline = "run" | "backup" | "review";
type LoopTargetKind = "repo" | "directory";
type LoopAgent = "claude" | "codex";

const VALID_REPOS: readonly Gorila360Repo[] = ["backend", "frontend"];
const VALID_AGENTS: readonly Gorila360Agent[] = ["claude", "codex"];
const VALID_PIPELINES: readonly Gorila360Pipeline[] = ["run", "backup", "review"];
const VALID_TARGET_KINDS: readonly LoopTargetKind[] = ["repo", "directory"];

function isValidRepo(value: unknown): value is Gorila360Repo {
  return typeof value === "string" && (VALID_REPOS as readonly string[]).includes(value);
}

function isValidAgent(value: unknown): value is Gorila360Agent | undefined {
  return value === undefined || (typeof value === "string" && (VALID_AGENTS as readonly string[]).includes(value as Gorila360Agent));
}

function isValidPipeline(value: unknown): value is Gorila360Pipeline {
  return typeof value === "string" && (VALID_PIPELINES as readonly string[]).includes(value as Gorila360Pipeline);
}

function isValidTargetKind(value: unknown): value is LoopTargetKind {
  return typeof value === "string" && (VALID_TARGET_KINDS as readonly string[]).includes(value);
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && isAbsolute(value);
}

function sanitizeBranchForPath(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
}

async function gitRepoRoot(repoPath: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, "rev-parse", "--show-toplevel"], {
    maxBuffer: 1024 * 1024
  });
  return stdout.trim();
}

async function ensureDirectoryExists(path: string): Promise<void> {
  await access(path).catch(async () => {
    throw new Error(`Target path does not exist: ${path}`);
  });
}

async function ensureGitRepo(repoPath: string): Promise<string> {
  await ensureDirectoryExists(repoPath);
  return gitRepoRoot(repoPath);
}

async function ensureWorktreeForRepo(
  repoPath: string,
  branch: string,
  baseRef?: string
): Promise<string> {
  const repoRoot = await ensureGitRepo(repoPath);
  const worktreeRoot = join(repoRoot, ".orquester", "worktrees");
  const worktreePath = join(worktreeRoot, sanitizeBranchForPath(branch));
  if (!(await access(worktreePath).then(() => true).catch(() => false))) {
    await mkdir(worktreeRoot, { recursive: true });
    const ref = baseRef || "HEAD";
    await execFileAsync("git", ["-C", repoRoot, "worktree", "add", "-B", branch, worktreePath, ref], {
      maxBuffer: 1024 * 1024
    });
  }
  return worktreePath;
}

async function prepareLoopExecutionPath(target: {
  kind: LoopTargetKind;
  path: string;
  branch?: string;
  baseRef?: string;
}): Promise<{ executionPath: string; worktree?: string }> {
  if (!isAbsolutePath(target.path)) {
    throw new Error("target.path must be an absolute path");
  }

  if (target.kind === "directory") {
    await ensureDirectoryExists(target.path);
    return { executionPath: target.path };
  }

  const repoRoot = await ensureGitRepo(target.path);
  if (target.branch) {
    const worktree = await ensureWorktreeForRepo(repoRoot, target.branch, target.baseRef);
    return { executionPath: worktree, worktree };
  }

  return { executionPath: repoRoot };
}

interface WorktreeListResponse {
  repo: string;
  output: string;
}

interface WorktreeCreateRequest {
  repo: Gorila360Repo;
  branch: string;
  baseRef?: string;
}

interface WorktreeRemoveRequest {
  repo: Gorila360Repo;
  branch: string;
}

interface LoopRunRequest {
  target: {
    kind: LoopTargetKind;
    path: string;
    branch?: string;
    baseRef?: string;
  };
  planPath: string;
  phase: string;
  agent?: LoopAgent;
  projectPath?: string;
}

interface LoopRunResponse {
  ok: true;
  target: {
    kind: LoopTargetKind;
    path: string;
    branch?: string;
    baseRef?: string;
  };
  phase: string;
  agent: string;
  projectPath: string;
  executionPath: string;
  worktree?: string;
  sessionId: string;
  outputUrl: string;
  repo?: string;
  branch?: string;
}

interface PipelineRunRequest {
  args?: string[];
  projectPath?: string;
}

interface PipelineRunResponse {
  ok: true;
  pipeline: Gorila360Pipeline;
  sessionId: string;
  outputUrl: string;
  cwd: string;
  command: string;
  projectPath: string;
}

interface Gorila360Services {
  sessions: SessionManager;
  broadcaster: Broadcaster;
}

function worktreeDir(repo: string, branch: string): string {
  return `${GORILA360_ROOT}/worktrees/${repo}/${branch.replace(/\//g, "-")}`;
}

async function runWorktreeScript(args: readonly string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync(WORKTREE_SCRIPT, args, {
    maxBuffer: 2 * 1024 * 1024,
    timeout: 120_000
  });
  return `${stdout}${stderr}`.trim();
}

function inferAgent(phase: string): Gorila360Agent {
  if (phase.toLowerCase().startsWith("fix") || phase.toLowerCase().startsWith("hotfix") || phase.toLowerCase().startsWith("patch")) {
    return "codex";
  }
  return "claude";
}

async function ensureTaskFile(
  executionPath: string,
  planPath: string,
  phase: string,
  agent: string,
  target: { kind: LoopTargetKind; path: string; branch?: string; baseRef?: string }
): Promise<string> {
  const planContent = await readFile(planPath, "utf8").catch(() => `⚠️ No se pudo leer el plan en ${planPath}`);

  const content = `# Tarea asignada por Orquester — Rails: Coding

## Plan
- Fichero: ${planPath}
- Fase: ${phase}
- Target kind: ${target.kind}
- Target path: ${target.path}
- Execution path: ${executionPath}
- Branch: ${target.branch ?? "(none)"}
- Agente: ${agent}

## Instrucciones
1. Lee el plan completo en "${planPath}".
2. Ejecuta **solo** la fase "${phase}".
3. Sigue el contrato del Rails de Gorila360:
   - Trabaja SIEMPRE dentro de: ${executionPath}
   - Usa los skills indicados en el plan.
   - No escribas tests E2E; eso es QA.
   - Añade \`Co-authored-by: Claude <claude@anthropic.com>\` en los commits.
4. Al finalizar, haz un resumen de archivos tocados y riesgos.
5. No salgas de la ruta de trabajo ni toques otras ramas.

## Plan completo
${planContent}
`;

  const taskFile = `${executionPath}/.orquester-task.md`;
  await mkdir(dirname(taskFile), { recursive: true });
  await writeFile(taskFile, content, "utf8");
  return taskFile;
}

async function launchLoopSession(
  services: Gorila360Services,
  target: { kind: LoopTargetKind; path: string; branch?: string; baseRef?: string },
  planPath: string,
  phase: string,
  agent: LoopAgent,
  eventChannel: string,
  projectPath?: string
): Promise<LoopRunResponse> {
  const prepared = await prepareLoopExecutionPath(target);
  await ensureTaskFile(prepared.executionPath, planPath, phase, agent, target);
  const sessionProjectPath = projectPath ?? target.path;

  const session = services.sessions.create({
    kind: "shell",
    refId: "bash",
    projectPath: sessionProjectPath,
    cwd: prepared.executionPath,
    cols: 120,
    rows: 40,
    title: `${target.kind}:${target.path}:${phase}`
  });

  const command = `${LOOP_AGENT_SCRIPT} ${JSON.stringify(prepared.executionPath)} ${JSON.stringify(agent)}\n`;
  services.sessions.input(session.id, command);

  const response: LoopRunResponse = {
    ok: true,
    target,
    phase,
    agent,
    projectPath: sessionProjectPath,
    executionPath: prepared.executionPath,
    worktree: prepared.worktree,
    sessionId: session.id,
    outputUrl: `/api/sessions/${session.id}/output`
  };

  services.broadcaster.publish(eventChannel, "loop.started", response);
  return response;
}

function buildPipelineCommand(pipeline: Gorila360Pipeline, args: readonly string[]): string {
  const scriptPath = `orchestration/${pipeline}_pipeline.py`;
  const quotedArgs = args.map((arg) => JSON.stringify(arg)).join(" ");
  return `python3 ${scriptPath}${quotedArgs ? ` ${quotedArgs}` : ""}\n`;
}

async function launchPipelineSession(
  services: Gorila360Services,
  pipeline: Gorila360Pipeline,
  args: string[],
  projectPath?: string
): Promise<PipelineRunResponse> {
  const cwd = GORILA360_ROOT;
  const command = buildPipelineCommand(pipeline, args);
  const sessionProjectPath = projectPath ?? "gorila360";

  const session = services.sessions.create({
    kind: "shell",
    refId: "bash",
    projectPath: sessionProjectPath,
    cwd,
    cols: 120,
    rows: 40,
    title: `gorila360:pipeline:${pipeline}`
  });

  services.sessions.input(session.id, command);

  const response: PipelineRunResponse = {
    ok: true,
    pipeline,
    sessionId: session.id,
    outputUrl: `/api/sessions/${session.id}/output`,
    cwd,
    command: command.trim(),
    projectPath: sessionProjectPath
  };

  services.broadcaster.publish("gorila360", `gorila360.pipeline.${pipeline}.started`, {
    sessionId: session.id,
    pipeline,
    args,
    cwd
  });

  return response;
}

export function registerGorila360Routes(app: FastifyInstance, services: Gorila360Services): void {
  const { sessions, broadcaster } = services;

  // List worktrees for a repo (or all repos).
  app.get<{ Querystring: { repo?: string } }>(
    "/api/gorila360/worktrees",
    async (request, reply): Promise<WorktreeListResponse[] | void> => {
      const repo = request.query.repo ?? "all";
      if (repo !== "all" && !isValidRepo(repo)) {
        return reply.code(400).send({ code: "INVALID_REPO", message: "repo must be 'backend', 'frontend' or omitted." });
      }

      try {
        if (repo === "all") {
          const [backendOutput, frontendOutput] = await Promise.all([
            runWorktreeScript(["list", "backend"]),
            runWorktreeScript(["list", "frontend"])
          ]);
          return [
            { repo: "backend", output: backendOutput },
            { repo: "frontend", output: frontendOutput }
          ];
        }
        const output = await runWorktreeScript(["list", repo]);
        return [{ repo, output }];
      } catch (error) {
        return reply.code(500).send({
          code: "WORKTREE_ERROR",
          message: error instanceof Error ? error.message : "Failed to list worktrees."
        });
      }
    }
  );

  // Create a new worktree.
  app.post<{ Body: WorktreeCreateRequest }>(
    "/api/gorila360/worktrees",
    async (request, reply): Promise<{ ok: true; output: string } | void> => {
      const { repo, branch, baseRef } = request.body ?? {};
      if (!isValidRepo(repo)) {
        return reply.code(400).send({ code: "INVALID_REPO", message: "repo must be 'backend' or 'frontend'." });
      }
      if (typeof branch !== "string" || branch.length === 0 || branch.includes("/") === false) {
        return reply.code(400).send({
          code: "INVALID_BRANCH",
          message: "branch must be a non-empty string like 'feature/name'."
        });
      }

      try {
        const args = baseRef ? ["create", repo, branch, baseRef] : ["create", repo, branch];
        const output = await runWorktreeScript(args);
        return { ok: true, output };
      } catch (error) {
        return reply.code(500).send({
          code: "WORKTREE_ERROR",
          message: error instanceof Error ? error.message : "Failed to create worktree."
        });
      }
    }
  );

  // Remove a worktree.
  app.delete<{ Body: WorktreeRemoveRequest }>(
    "/api/gorila360/worktrees",
    async (request, reply): Promise<{ ok: true; output: string } | void> => {
      const { repo, branch } = request.body ?? {};
      if (!isValidRepo(repo)) {
        return reply.code(400).send({ code: "INVALID_REPO", message: "repo must be 'backend' or 'frontend'." });
      }
      if (typeof branch !== "string" || branch.length === 0) {
        return reply.code(400).send({ code: "INVALID_BRANCH", message: "branch is required." });
      }

      try {
        const output = await runWorktreeScript(["remove", repo, branch]);
        return { ok: true, output };
      } catch (error) {
        return reply.code(500).send({
          code: "WORKTREE_ERROR",
          message: error instanceof Error ? error.message : "Failed to remove worktree."
        });
      }
    }
  );

  // Run a generic loop on any repo or directory target.
  app.post<{ Body: LoopRunRequest }>(
    "/api/loops",
    async (request, reply): Promise<LoopRunResponse | void> => {
      const body = request.body ?? {};
      const target = body.target;
      const { planPath, phase, agent } = body;

      if (!target || !isValidTargetKind(target.kind)) {
        return reply.code(400).send({ code: "INVALID_TARGET", message: "target.kind must be 'repo' or 'directory'." });
      }
      if (!isAbsolutePath(target.path)) {
        return reply.code(400).send({ code: "INVALID_TARGET_PATH", message: "target.path must be an absolute path." });
      }
      if (target.branch !== undefined && typeof target.branch !== "string") {
        return reply.code(400).send({ code: "INVALID_BRANCH", message: "branch must be a string when provided." });
      }
      if (target.baseRef !== undefined && typeof target.baseRef !== "string") {
        return reply.code(400).send({ code: "INVALID_BASE_REF", message: "baseRef must be a string when provided." });
      }
      if (typeof planPath !== "string" || planPath.length === 0) {
        return reply.code(400).send({ code: "INVALID_PLAN_PATH", message: "planPath is required." });
      }
      if (typeof phase !== "string" || phase.length === 0) {
        return reply.code(400).send({ code: "INVALID_PHASE", message: "phase is required." });
      }
      if (!isValidAgent(agent)) {
        return reply.code(400).send({ code: "INVALID_AGENT", message: "agent must be 'claude' or 'codex'." });
      }

      const selectedAgent = agent ?? inferAgent(phase);

      try {
        return await launchLoopSession(
          services,
          { kind: target.kind, path: target.path, branch: target.branch, baseRef: target.baseRef },
          planPath,
          phase,
          selectedAgent,
          "loops",
          body.projectPath
        );
      } catch (error) {
        return reply.code(500).send({
          code: "LOOP_ERROR",
          message: error instanceof Error ? error.message : "Failed to run loop."
        });
      }
    }
  );

  // Run a Gorila360 Rails loop: keep compatibility with the existing request shape.
  app.post<{ Body: LoopRunRequest & { repo?: Gorila360Repo; branch?: string } }>(
    "/api/gorila360/loops",
    async (request, reply): Promise<LoopRunResponse | void> => {
      const body = request.body ?? {};
      const repo = body.repo;
      const branch = body.branch;
      const { planPath, phase, agent } = body;

      if (!isValidRepo(repo)) {
        return reply.code(400).send({ code: "INVALID_REPO", message: "repo must be 'backend' or 'frontend'." });
      }
      if (typeof branch !== "string" || branch.length === 0 || branch.includes("/") === false) {
        return reply.code(400).send({
          code: "INVALID_BRANCH",
          message: "branch must be a non-empty string like 'feature/name'."
        });
      }
      if (typeof planPath !== "string" || planPath.length === 0) {
        return reply.code(400).send({ code: "INVALID_PLAN_PATH", message: "planPath is required." });
      }
      if (typeof phase !== "string" || phase.length === 0) {
        return reply.code(400).send({ code: "INVALID_PHASE", message: "phase is required." });
      }
      if (!isValidAgent(agent)) {
        return reply.code(400).send({ code: "INVALID_AGENT", message: "agent must be 'claude' or 'codex'." });
      }

      const selectedAgent = agent ?? inferAgent(phase);
      const targetPath = `${GORILA360_ROOT}/${repo}`;
      const worktree = worktreeDir(repo, branch);

      try {
        // Preserve the existing Gorila360 worktree bridge.
        if (!(await execFileAsync("test", ["-d", worktree]).then(() => true).catch(() => false))) {
          await runWorktreeScript(["create", repo, branch]);
        }

        await ensureTaskFile(worktree, planPath, phase, selectedAgent, {
          kind: "repo",
          path: targetPath,
          branch
        });

        const session = sessions.create({
          kind: "shell",
          refId: "bash",
          projectPath: `gorila360/${repo}`,
          cwd: worktree,
          cols: 120,
          rows: 40,
          title: `gorila360:${repo}:${branch}:${phase}`
        });

        const command = `${LOOP_AGENT_SCRIPT} ${JSON.stringify(worktree)} ${JSON.stringify(selectedAgent)}\n`;
        sessions.input(session.id, command);

        const response: LoopRunResponse = {
          ok: true,
          target: { kind: "repo", path: targetPath, branch },
          phase,
          agent: selectedAgent,
          projectPath: body.projectPath ?? `gorila360/${repo}`,
          executionPath: worktree,
          worktree,
          sessionId: session.id,
          outputUrl: `/api/sessions/${session.id}/output`
        };

        broadcaster.publish("loops", "loop.started", response);
        broadcaster.publish("gorila360", "gorila360.loop.started", {
          sessionId: session.id,
          repo,
          branch,
          phase,
          agent: selectedAgent,
          worktree
        });

        return {
          ...response,
          repo,
          branch
        };
      } catch (error) {
        return reply.code(500).send({
          code: "LOOP_ERROR",
          message: error instanceof Error ? error.message : "Failed to run Gorila360 loop."
        });
      }
    }
  );

  // Run the Gorila360 test pipeline (run_pipeline.py).
  app.post<{ Body: PipelineRunRequest }>(
    "/api/gorila360/pipelines/run",
    async (request, reply): Promise<PipelineRunResponse | void> => {
      const { args, projectPath } = request.body ?? {};
      if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== "string"))) {
        return reply.code(400).send({ code: "INVALID_ARGS", message: "args must be an array of strings." });
      }

      try {
        return await launchPipelineSession(services, "run", args ?? [], projectPath);
      } catch (error) {
        return reply.code(500).send({
          code: "PIPELINE_ERROR",
          message: error instanceof Error ? error.message : "Failed to run pipeline."
        });
      }
    }
  );

  // Run the Gorila360 backup pipeline (backup_pipeline.py).
  app.post<{ Body: PipelineRunRequest }>(
    "/api/gorila360/pipelines/backup",
    async (request, reply): Promise<PipelineRunResponse | void> => {
      const { args, projectPath } = request.body ?? {};
      if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== "string"))) {
        return reply.code(400).send({ code: "INVALID_ARGS", message: "args must be an array of strings." });
      }

      try {
        return await launchPipelineSession(services, "backup", args ?? [], projectPath);
      } catch (error) {
        return reply.code(500).send({
          code: "PIPELINE_ERROR",
          message: error instanceof Error ? error.message : "Failed to run backup pipeline."
        });
      }
    }
  );

  // Run the Gorila360 review pipeline (review_pipeline.py).
  app.post<{ Body: PipelineRunRequest }>(
    "/api/gorila360/pipelines/review",
    async (request, reply): Promise<PipelineRunResponse | void> => {
      const { args, projectPath } = request.body ?? {};
      if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== "string"))) {
        return reply.code(400).send({ code: "INVALID_ARGS", message: "args must be an array of strings." });
      }

      try {
        return await launchPipelineSession(services, "review", args ?? [], projectPath);
      } catch (error) {
        return reply.code(500).send({
          code: "PIPELINE_ERROR",
          message: error instanceof Error ? error.message : "Failed to run review pipeline."
        });
      }
    }
  );
}
