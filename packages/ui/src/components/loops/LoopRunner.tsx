import React, { useEffect, useState } from "react";
import {
  ExternalLink,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Loader2,
  Play,
  Plus,
  Repeat,
  Sparkles,
  Square,
  Trash2,
  Workflow,
  X
} from "lucide-react";
import { cn } from "../../lib/cn";
import { useAppStore } from "../../store/app";
import type { AgentLoopParticipant, AgentSkill, LoopRunResponse, LoopTargetKind } from "../../types";
import { Button, Input } from "../ui";
import { FolderPickerModal } from "../files";

const AGENTS = [
  { id: "claude" as const, name: "Claude Code" },
  { id: "codex" as const, name: "Codex" },
  { id: "opencode" as const, name: "OpenCode" },
  { id: "kimi" as const, name: "Kimi" },
  { id: "pi" as const, name: "Pi" },
  { id: "gemini" as const, name: "Gemini" }
];

const AGENT_NAME: Record<string, string> = Object.fromEntries(AGENTS.map((a) => [a.id, a.name]));

/** Agents offered for the single-shot loop (only claude/codex are wired there). */
const SINGLE_AGENTS = AGENTS.filter((a) => a.id === "claude" || a.id === "codex");

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
  const api = useAppStore((s) => s.api);
  const currentProject = useAppStore((s) => s.currentProject);
  const activateTab = useAppStore((s) => s.activateTab);
  const startAgentLoop = useAppStore((s) => s.startAgentLoop);
  const stopAgentLoop = useAppStore((s) => s.stopAgentLoop);
  const refineLoopPrompt = useAppStore((s) => s.refineLoopPrompt);
  const agentLoop = useAppStore((s) => s.agentLoop);
  const loopBlocks = useAppStore((s) => s.loopBlocks);
  const addLoopBlock = useAppStore((s) => s.addLoopBlock);
  const removeLoopBlock = useAppStore((s) => s.removeLoopBlock);

  const [path, setPath] = useState(currentProject?.path ?? "");
  const [task, setTask] = useState("");
  const [participants, setParticipants] = useState<AgentLoopParticipant[]>([
    { agent: "claude", role: "Implementador", skill: "" },
    { agent: "codex", role: "Revisor", skill: "" }
  ]);
  const [activeBlockIds, setActiveBlockIds] = useState<string[]>([]);
  const [coordinationDir, setCoordinationDir] = useState("");
  const [gitSnapshot, setGitSnapshot] = useState(false);
  const [maxRounds, setMaxRounds] = useState(3);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skillsByAgent, setSkillsByAgent] = useState<Record<string, AgentSkill[]>>({});
  const [blockPicker, setBlockPicker] = useState(false);
  const [refining, setRefining] = useState(false);
  const [pendingRefine, setPendingRefine] = useState<string | null>(null);

  useEffect(() => {
    if (!path && currentProject?.path) {
      setPath(currentProject.path);
    }
  }, [currentProject?.path, path]);

  // Load installed skills for each agent in the roster (for the skill picker).
  useEffect(() => {
    if (!api) return;
    const agents = [...new Set(participants.map((p) => p.agent))];
    let cancelled = false;
    (async () => {
      for (const a of agents) {
        if (skillsByAgent[a]) continue;
        const skills = await api.listAgentSkills(a).catch(() => [] as AgentSkill[]);
        if (!cancelled) setSkillsByAgent((prev) => ({ ...prev, [a]: skills }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [participants, api, skillsByAgent]);

  // Poll the refined-spec file pi writes; when it appears, load it as the task.
  useEffect(() => {
    if (!pendingRefine || !api) return;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (cancelled) return;
      attempts += 1;
      const content = await api
        .readFile(pendingRefine)
        .then((r) => r?.content?.trim() ?? "")
        .catch(() => "");
      if (cancelled) return;
      if (content) {
        setTask(content);
        setPendingRefine(null);
        setRefining(false);
        return;
      }
      if (attempts > 400) {
        setPendingRefine(null);
        setRefining(false);
        return;
      }
      timer = setTimeout(tick, 3000);
    };
    timer = setTimeout(tick, 3000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pendingRefine, api]);

  const running = agentLoop?.state === "running";
  const extraDirs = loopBlocks.filter((b) => activeBlockIds.includes(b.id)).map((b) => b.path);
  const canStart = Boolean(path.trim() && task.trim() && participants.length > 0 && !running);

  const addParticipant = (agent: string) =>
    setParticipants((prev) => [...prev, { agent, role: "", skill: "" }]);
  const updateParticipant = (index: number, patch: Partial<AgentLoopParticipant>) =>
    setParticipants((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  const removeParticipant = (index: number) =>
    setParticipants((prev) => prev.filter((_, i) => i !== index));
  const toggleBlock = (id: string) =>
    setActiveBlockIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const refine = async () => {
    if (!path.trim()) return;
    setError(null);
    setRefining(true);
    try {
      const res = await refineLoopPrompt({
        path: path.trim(),
        task: task.trim() || "Definir la tarea desde cero.",
        projectPath: currentProject?.path ?? path.trim(),
        coordinationDir: coordinationDir.trim() || undefined
      });
      activateTab(res.sessionId);
      setPendingRefine(res.refinedPath);
    } catch (refineError) {
      setError(refineError instanceof Error ? refineError.message : "Failed to start refine.");
      setRefining(false);
    }
  };

  const start = async () => {
    setError(null);
    setLaunching(true);
    try {
      const res = await startAgentLoop({
        path: path.trim(),
        extraDirs,
        coordinationDir: coordinationDir.trim() || undefined,
        task: task.trim(),
        participants: participants.map((p) => ({
          agent: p.agent,
          role: p.role?.trim() || undefined,
          skill: p.skill?.trim() || undefined
        })),
        maxRounds,
        gitSnapshot,
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

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-neutral-500">
              Task not well-defined? pi will interview you and refine it.
            </span>
            <Button variant="outline" size="sm" onClick={() => void refine()} disabled={!path.trim() || refining}>
              {refining ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              Refine with pi
            </Button>
          </div>
          {refining && (
            <p className="text-xs text-cyan-300/80">
              pi is interviewing you in its tab — answer its questions; the refined task lands here automatically.
            </p>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">Code folders (blocks)</span>
              <button
                type="button"
                onClick={() => setBlockPicker(true)}
                className="inline-flex items-center gap-1 rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
              >
                <FolderPlus size={12} />
                Add block
              </button>
            </div>
            {loopBlocks.length === 0 ? (
              <p className="text-xs text-neutral-600">
                No blocks yet. The working directory above is always included; add blocks to let agents
                modify extra folders.
              </p>
            ) : (
              loopBlocks.map((b) => (
                <div
                  key={b.id}
                  className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-950/50 px-2 py-1.5"
                >
                  <input
                    type="checkbox"
                    checked={activeBlockIds.includes(b.id)}
                    onChange={() => toggleBlock(b.id)}
                    className="h-4 w-4 accent-cyan-500"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">
                    {b.label} <span className="text-neutral-600">· {b.path}</span>
                  </span>
                  <button
                    type="button"
                    aria-label="Remove block"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-red-400"
                    onClick={() => void removeLoopBlock(b.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))
            )}
          </div>

          <label className="block space-y-1">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
              Coordination folder (optional)
            </span>
            <Input
              value={coordinationDir}
              onChange={(event) => setCoordinationDir(event.target.value)}
              placeholder="Default: Orquester work folder (keeps chatter out of the repo)"
            />
          </label>

          <div className="space-y-2">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
              Participants (role + skill, in relay order)
            </span>
            {participants.length === 0 && (
              <p className="text-xs text-neutral-600">Add at least one participant…</p>
            )}
            <div className="space-y-2">
              {participants.map((p, index) => (
                <div
                  key={index}
                  className="space-y-2 rounded-lg border border-neutral-800 bg-neutral-950/50 p-2.5"
                >
                  <div className="flex items-center gap-2">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-neutral-800 text-[10px] text-neutral-400">
                      {index + 1}
                    </span>
                    <span className="flex-1 text-sm font-medium text-neutral-100">
                      {AGENT_NAME[p.agent] ?? p.agent}
                    </span>
                    <button
                      type="button"
                      aria-label="Remove participant"
                      className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-red-400"
                      onClick={() => removeParticipant(index)}
                    >
                      <X size={13} />
                    </button>
                  </div>
                  <Input
                    value={p.role ?? ""}
                    onChange={(event) => updateParticipant(index, { role: event.target.value })}
                    placeholder="Role (e.g. Implementer, Reviewer, Tester)"
                  />
                  {(skillsByAgent[p.agent]?.length ?? 0) > 0 && (
                    <select
                      value=""
                      onChange={(event) => {
                        if (event.target.value) updateParticipant(index, { skill: event.target.value });
                      }}
                      className="h-9 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 text-sm text-neutral-300 outline-none focus:ring-1 focus:ring-neutral-500"
                    >
                      <option value="">Insert installed skill…</option>
                      {skillsByAgent[p.agent]!.map((s) => (
                        <option key={s.name} value={s.description ? `${s.name}: ${s.description}` : s.name}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <textarea
                    value={p.skill ?? ""}
                    onChange={(event) => updateParticipant(index, { skill: event.target.value })}
                    rows={2}
                    placeholder="Skill / instructions for this agent's turns…"
                    className="w-full resize-y rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:ring-1 focus:ring-neutral-500"
                  />
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {AGENTS.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => addParticipant(agent.id)}
                  className="inline-flex items-center gap-1 rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
                >
                  <Plus size={12} />
                  {agent.name}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-300">
              <input
                type="checkbox"
                checked={gitSnapshot}
                onChange={(event) => setGitSnapshot(event.target.checked)}
                className="h-4 w-4 rounded border-neutral-600 bg-neutral-950 accent-cyan-500"
              />
              <GitBranch size={14} className="text-neutral-500" />
              Git snapshot per turn
            </label>
            <label className="flex items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">Max rounds</span>
              <input
                type="number"
                min={1}
                max={50}
                value={maxRounds}
                onChange={(event) => setMaxRounds(Math.max(1, Math.min(50, Number(event.target.value) || 1)))}
                className="h-9 w-20 rounded-md border border-neutral-700 bg-neutral-950 px-3 text-sm text-neutral-100 outline-none focus:ring-1 focus:ring-neutral-500"
              />
            </label>
          </div>

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
                  {agentLoop.role && <span className="text-neutral-500"> · {agentLoop.role}</span>}
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

      <FolderPickerModal
        open={blockPicker}
        title="Add a code folder block"
        confirmLabel="Add block"
        startDir="/"
        onPick={(dir) => {
          setBlockPicker(false);
          const name = dir.replace(/\/+$/, "").split("/").pop() || dir;
          void addLoopBlock(name, dir);
        }}
        onClose={() => setBlockPicker(false)}
      />
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
  const [agent, setAgent] = useState<"claude" | "codex">("claude");
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
                onChange={(event) => setAgent(event.target.value as "claude" | "codex")}
                className="h-9 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 text-sm text-neutral-100 outline-none focus:ring-1 focus:ring-neutral-500"
              >
                {SINGLE_AGENTS.map((item) => (
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
