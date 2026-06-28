import React, { useEffect, useState } from "react";
import {
  ExternalLink,
  FolderOpen,
  GitBranch,
  Loader2,
  Play,
  Plus,
  Repeat,
  Square,
  Workflow,
  X
} from "lucide-react";
import { cn } from "../../lib/cn";
import { useAppStore } from "../../store/app";
import type { LoopRunResponse, LoopTargetKind } from "../../types";
import { Button, Input } from "../ui";

const AGENTS = [
  { id: "claude" as const, name: "Claude Code" },
  { id: "codex" as const, name: "Codex" }
];

const AGENT_NAME: Record<string, string> = Object.fromEntries(AGENTS.map((a) => [a.id, a.name]));

type Mode = "relay" | "single";

export const LoopRunner: React.FC = () => {
  const [mode, setMode] = useState<Mode>("relay");

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-6 text-neutral-200">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-xl font-semibold">
          <Workflow size={22} className="text-cyan-400" />
          Loop Runner
        </h2>
        <div className="flex rounded-md border border-neutral-800 p-0.5 text-sm">
          <button
            type="button"
            onClick={() => setMode("relay")}
            className={cn(
              "flex items-center gap-1.5 rounded px-3 py-1",
              mode === "relay" ? "bg-cyan-500/20 text-cyan-200" : "text-neutral-400 hover:text-neutral-200"
            )}
          >
            <Repeat size={14} />
            Relay (multi-agente)
          </button>
          <button
            type="button"
            onClick={() => setMode("single")}
            className={cn(
              "rounded px-3 py-1",
              mode === "single" ? "bg-cyan-500/20 text-cyan-200" : "text-neutral-400 hover:text-neutral-200"
            )}
          >
            Single (plan/fase)
          </button>
        </div>
      </div>

      {mode === "relay" ? <RelayPanel /> : <SinglePanel />}
    </div>
  );
};

/** New multi-agent relay: hand a task between agents in turn until done. */
const RelayPanel: React.FC = () => {
  const currentProject = useAppStore((s) => s.currentProject);
  const activateTab = useAppStore((s) => s.activateTab);
  const startAgentLoop = useAppStore((s) => s.startAgentLoop);
  const stopAgentLoop = useAppStore((s) => s.stopAgentLoop);
  const agentLoop = useAppStore((s) => s.agentLoop);

  const [path, setPath] = useState(currentProject?.path ?? "");
  const [task, setTask] = useState("");
  const [sequence, setSequence] = useState<string[]>(["claude", "codex"]);
  const [maxRounds, setMaxRounds] = useState(3);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path && currentProject?.path) {
      setPath(currentProject.path);
    }
  }, [currentProject?.path, path]);

  const running = agentLoop?.state === "running";
  const canStart = Boolean(path.trim() && task.trim() && sequence.length > 0 && !running);

  const start = async () => {
    setError(null);
    setLaunching(true);
    try {
      const res = await startAgentLoop({
        path: path.trim(),
        task: task.trim(),
        agents: sequence,
        maxRounds,
        projectPath: currentProject?.path ?? path.trim()
      });
      activateTab(res.sessionId);
    } catch (loopError) {
      setError(loopError instanceof Error ? loopError.message : "Failed to start relay.");
    } finally {
      setLaunching(false);
    }
  };

  return (
    <>
      <p className="max-w-3xl text-sm text-neutral-400">
        Define a task and an ordered list of agents. The daemon hands the task between them turn by turn — each agent
        reads what the previous ones did (a shared <code className="text-neutral-300">baton.md</code>), does the next
        step, and the relay stops when an agent declares it done or after the max rounds.
      </p>

      {error && (
        <div className="rounded-md border border-red-900/60 bg-red-950/40 p-3 text-sm text-red-200">{error}</div>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-4 rounded-xl border border-neutral-800 bg-neutral-900/70 p-4">
          <label className="block space-y-1">
            <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
              <FolderOpen size={13} />
              Working directory
            </span>
            <Input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="/absolute/path/to/repo-or-directory"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">Task</span>
            <textarea
              value={task}
              onChange={(event) => setTask(event.target.value)}
              rows={5}
              placeholder="Describe the task the agents should accomplish together…"
              className="w-full resize-y rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:ring-1 focus:ring-neutral-500"
            />
          </label>

          <div className="space-y-2">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">Agent sequence</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {sequence.length === 0 && (
                <span className="text-xs text-neutral-600">Add at least one agent…</span>
              )}
              {sequence.map((id, index) => (
                <span
                  key={`${id}-${index}`}
                  className="inline-flex items-center gap-1 rounded-full bg-neutral-800 py-1 pl-2.5 pr-1 text-xs text-neutral-200"
                >
                  <span className="text-neutral-500">{index + 1}.</span>
                  {AGENT_NAME[id] ?? id}
                  <button
                    type="button"
                    aria-label="Remove"
                    className="flex h-4 w-4 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-700 hover:text-red-300"
                    onClick={() => setSequence(sequence.filter((_, i) => i !== index))}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {AGENTS.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => setSequence([...sequence, agent.id])}
                  className="inline-flex items-center gap-1 rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
                >
                  <Plus size={12} />
                  {agent.name}
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">Max rounds (full cycles)</span>
            <input
              type="number"
              min={1}
              max={50}
              value={maxRounds}
              onChange={(event) => setMaxRounds(Math.max(1, Math.min(50, Number(event.target.value) || 1)))}
              className="h-9 w-20 rounded-md border border-neutral-700 bg-neutral-950 px-3 text-sm text-neutral-100 outline-none focus:ring-1 focus:ring-neutral-500"
            />
          </label>

          <div className="flex items-center justify-end gap-2">
            {running && (
              <Button variant="outline" size="sm" onClick={() => void stopAgentLoop()}>
                <Square size={13} />
                Stop
              </Button>
            )}
            <Button onClick={start} disabled={!canStart || launching}>
              {launching ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              Start relay
            </Button>
          </div>
        </div>

        <div className="space-y-4 rounded-xl border border-neutral-800 bg-neutral-900/70 p-4">
          <h3 className="text-sm font-medium text-neutral-400">Relay status</h3>
          {agentLoop ? (
            <div className="space-y-3 text-sm">
              <div className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-3">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full",
                      agentLoop.state === "running" ? "animate-pulse bg-cyan-400" : "bg-neutral-600"
                    )}
                  />
                  <span className="font-medium text-neutral-100">
                    {agentLoop.state === "running" ? "Running" : "Finished"}
                  </span>
                  {agentLoop.reason && (
                    <span className="text-xs text-neutral-500">· {agentLoop.reason}</span>
                  )}
                </div>
                <div className="mt-2 text-neutral-400">
                  Turn <span className="text-neutral-200">{agentLoop.round + 1}</span> · agent{" "}
                  <span className="text-neutral-200">{AGENT_NAME[agentLoop.agent] ?? agentLoop.agent}</span>
                </div>
                {agentLoop.message && <div className="mt-1 text-xs text-neutral-500">{agentLoop.message}</div>}
              </div>
              <button
                type="button"
                onClick={() => activateTab(agentLoop.sessionId)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md bg-cyan-500/15 px-3 py-1.5 font-medium text-cyan-300",
                  "hover:bg-cyan-500/25"
                )}
              >
                <ExternalLink size={14} />
                Open relay session
              </button>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-neutral-800 p-4 text-sm text-neutral-500">
              No relay running yet.
            </div>
          )}
        </div>
      </div>
    </>
  );
};

/** Original single-shot loop: one agent runs a plan/phase once. */
const SinglePanel: React.FC = () => {
  const api = useAppStore((s) => s.api);
  const currentProject = useAppStore((s) => s.currentProject);
  const activateTab = useAppStore((s) => s.activateTab);

  const [targetKind, setTargetKind] = useState<LoopTargetKind>("repo");
  const [targetPath, setTargetPath] = useState(currentProject?.path ?? "");
  const [branch, setBranch] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [planPath, setPlanPath] = useState("");
  const [phase, setPhase] = useState("coding");
  const [agent, setAgent] = useState<(typeof AGENTS)[number]["id"]>("claude");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<LoopRunResponse | null>(null);

  useEffect(() => {
    if (!targetPath && currentProject?.path) {
      setTargetPath(currentProject.path);
    }
  }, [currentProject?.path, targetPath]);

  const canRun = Boolean(api && targetPath.trim() && planPath.trim() && phase.trim());

  const runLoop = async () => {
    if (!api || !targetPath || !planPath || !phase) {
      return;
    }
    setError(null);
    setRunning(true);
    try {
      const result = await api.runLoop({
        target: {
          kind: targetKind,
          path: targetPath.trim(),
          branch: targetKind === "repo" && branch.trim() ? branch.trim() : undefined,
          baseRef: targetKind === "repo" && baseRef.trim() ? baseRef.trim() : undefined
        },
        planPath: planPath.trim(),
        phase: phase.trim(),
        agent,
        projectPath: currentProject?.path ?? targetPath.trim()
      });
      setLastRun(result);
    } catch (loopError) {
      setError(loopError instanceof Error ? loopError.message : "Failed to launch loop.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <p className="max-w-3xl text-sm text-neutral-400">
        Launch a coding loop against a git repo or a plain directory. If you provide a branch for a repo, the daemon
        will create or reuse a worktree. Leaving branch empty runs directly on the checkout.
      </p>

      {error && (
        <div className="rounded-md border border-red-900/60 bg-red-950/40 p-3 text-sm text-red-200">{error}</div>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-4 rounded-xl border border-neutral-800 bg-neutral-900/70 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">Target kind</span>
              <select
                value={targetKind}
                onChange={(event) => setTargetKind(event.target.value as LoopTargetKind)}
                className="h-9 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 text-sm text-neutral-100 outline-none focus:ring-1 focus:ring-neutral-500"
              >
                <option value="repo">Repo</option>
                <option value="directory">Directory</option>
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">Agent</span>
              <select
                value={agent}
                onChange={(event) => setAgent(event.target.value as (typeof AGENTS)[number]["id"])}
                className="h-9 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 text-sm text-neutral-100 outline-none focus:ring-1 focus:ring-neutral-500"
              >
                {AGENTS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block space-y-1">
            <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
              <FolderOpen size={13} />
              Target path
            </span>
            <Input
              value={targetPath}
              onChange={(event) => setTargetPath(event.target.value)}
              placeholder="/absolute/path/to/repo-or-directory"
            />
          </label>

          {targetKind === "repo" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
                  <GitBranch size={13} />
                  Branch
                </span>
                <Input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="feature/my-loop" />
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">Base ref</span>
                <Input value={baseRef} onChange={(event) => setBaseRef(event.target.value)} placeholder="main" />
              </label>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">Plan file</span>
              <Input
                value={planPath}
                onChange={(event) => setPlanPath(event.target.value)}
                placeholder="/absolute/path/to/spec.md"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">Phase</span>
              <Input value={phase} onChange={(event) => setPhase(event.target.value)} placeholder="coding" />
            </label>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-neutral-500">
              {targetKind === "repo" ? "Branch enables worktree creation." : "Directory runs directly in place."}
            </div>
            <Button onClick={runLoop} disabled={!canRun || running}>
              {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              Launch loop
            </Button>
          </div>
        </div>

        <div className="space-y-4 rounded-xl border border-neutral-800 bg-neutral-900/70 p-4">
          <h3 className="text-sm font-medium text-neutral-400">Last run</h3>
          {lastRun ? (
            <div className="space-y-3 text-sm">
              <div className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-3">
                <div className="font-medium text-neutral-100">{lastRun.phase}</div>
                <div className="mt-1 text-neutral-400">
                  {lastRun.target.kind} · {lastRun.target.path}
                </div>
                <div className="mt-1 text-neutral-400">
                  Execution: <span className="text-neutral-200">{lastRun.executionPath}</span>
                </div>
                {lastRun.worktree && (
                  <div className="mt-1 text-neutral-400">
                    Worktree: <span className="text-neutral-200">{lastRun.worktree}</span>
                  </div>
                )}
                <div className="mt-1 text-neutral-400">
                  Agent: <span className="text-neutral-200">{lastRun.agent}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => activateTab(lastRun.sessionId)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md bg-cyan-500/15 px-3 py-1.5 font-medium text-cyan-300",
                  "hover:bg-cyan-500/25"
                )}
              >
                <ExternalLink size={14} />
                Open session {lastRun.sessionId.slice(0, 8)}…
              </button>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-neutral-800 p-4 text-sm text-neutral-500">
              No loop has been launched yet.
            </div>
          )}
        </div>
      </div>
    </>
  );
};
