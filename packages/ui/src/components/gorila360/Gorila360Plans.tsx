import React, { useEffect, useState } from "react";
import { useAppStore } from "../../store/app";
import { useAsyncResource } from "../../hooks/use-async-resource";
import type { Gorila360LoopRunResponse, Gorila360PlanSummary } from "../../types";
import { Play, FileText, Loader2, ExternalLink, Banana } from "lucide-react";
import { cn } from "../../lib/cn";

interface PlanPhase {
  id: string;
  title: string;
}

function parsePhases(content: string): PlanPhase[] {
  const lines = content.split("\n");
  const phases: PlanPhase[] = [];
  for (const line of lines) {
    const match = line.match(/^##\s+(Task\s+\S+|Fase\s+\S+|Phase\s+\S+)\s*[:-]?\s*(.*)$/i);
    if (match) {
      phases.push({ id: match[1].trim(), title: match[2].trim() });
    }
  }
  return phases;
}

function inferRepo(planPath: string): "backend" | "frontend" {
  return planPath.toLowerCase().includes("frontend") ? "frontend" : "backend";
}

function phaseBranch(planId: string, phaseId: string): string {
  const cleanPhase = phaseId.replace(/\s+/g, "-").toLowerCase();
  return `feature/${planId}-${cleanPhase}`;
}

export const Gorila360Plans: React.FC = () => {
  const api = useAppStore((s) => s.api);
  const currentProject = useAppStore((s) => s.currentProject);
  const [selectedPlan, setSelectedPlan] = useState<Gorila360PlanSummary | null>(null);
  const [planContent, setPlanContent] = useState<string>("");
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [lastRun, setLastRun] = useState<Gorila360LoopRunResponse | null>(null);

  const { data: plans, loading, error, reload } = useAsyncResource(
    (signal) => api?.listGorila360Plans(signal) ?? Promise.resolve([]),
    [],
    [api]
  );

  useEffect(() => {
    if (!selectedPlan) {
      setPlanContent("");
      return;
    }
    api
      ?.readFile(selectedPlan.path)
      .then((res) => setPlanContent(res.content))
      .catch(() => setPlanContent(""));
  }, [api, selectedPlan]);

  const phases = parsePhases(planContent);

  const runPhase = async (phase: PlanPhase) => {
    if (!api || !selectedPlan) return;
    const key = `${selectedPlan.id}-${phase.id}`;
    setRunning((prev) => ({ ...prev, [key]: true }));
    try {
      const repo = inferRepo(selectedPlan.path);
      const branch = phaseBranch(selectedPlan.id, phase.id);
      const result = await api.runGorila360Loop({
        repo,
        branch,
        planPath: selectedPlan.path,
        phase: phase.id,
        agent: "claude",
        projectPath: currentProject?.path
      });
      setLastRun(result);
    } finally {
      setRunning((prev) => ({ ...prev, [key]: false }));
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-6 text-neutral-200">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-xl font-semibold">
          <Banana size={22} className="text-yellow-500" />
          Gorila360 Plans
        </h2>
        <button
          onClick={reload}
          disabled={loading}
          className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700 disabled:opacity-50"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : "Refresh"}
        </button>
      </div>

      {error && <div className="rounded-md bg-red-900/30 p-3 text-red-200">{error.message}</div>}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-neutral-400">Available plans</h3>
          <div className="flex flex-col gap-2">
            {plans?.map((plan) => (
              <button
                key={plan.id}
                onClick={() => setSelectedPlan(plan)}
                className={cn(
                  "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                  selectedPlan?.id === plan.id
                    ? "border-yellow-500/50 bg-yellow-500/10"
                    : "border-neutral-800 bg-neutral-900 hover:border-neutral-700"
                )}
              >
                <FileText size={18} className="mt-0.5 shrink-0 text-neutral-400" />
                <div className="min-w-0">
                  <div className="truncate font-medium">{plan.name}</div>
                  <div className="text-xs text-neutral-500">{plan.filename}</div>
                </div>
              </button>
            ))}
            {!loading && plans?.length === 0 && (
              <div className="text-sm text-neutral-500">No plans found in Gorila360.</div>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-neutral-400">Phases</h3>
          {selectedPlan ? (
            <div className="flex flex-col gap-2">
              {phases.length > 0 ? (
                phases.map((phase) => {
                  const key = `${selectedPlan.id}-${phase.id}`;
                  const isRunning = running[key];
                  return (
                    <div
                      key={phase.id}
                      className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900 p-3"
                    >
                      <div className="min-w-0">
                        <div className="font-medium">{phase.id}</div>
                        <div className="truncate text-sm text-neutral-400">{phase.title}</div>
                      </div>
                      <button
                        onClick={() => runPhase(phase)}
                        disabled={isRunning}
                        className="flex shrink-0 items-center gap-1.5 rounded-md bg-yellow-600 px-3 py-1.5 text-sm font-medium text-black hover:bg-yellow-500 disabled:opacity-60"
                      >
                        {isRunning ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Play size={14} />
                        )}
                        Run
                      </button>
                    </div>
                  );
                })
              ) : (
                <div className="text-sm text-neutral-500">No phases detected in this plan.</div>
              )}

              {lastRun && (
                <div className="mt-2 rounded-lg border border-green-800 bg-green-900/20 p-3 text-sm">
                  <div className="font-medium text-green-300">Loop started</div>
                  <div className="mt-1 text-neutral-300">
                    <span className="font-medium">Phase:</span> {lastRun.phase}
                  </div>
                  <div className="text-neutral-300">
                    <span className="font-medium">Branch:</span> {lastRun.branch}
                  </div>
                  <div className="text-neutral-300">
                    <span className="font-medium">Worktree:</span> {lastRun.worktree}
                  </div>
                  <a
                    href={`#session-${lastRun.sessionId}`}
                    onClick={(e) => {
                      e.preventDefault();
                      useAppStore.getState().activateTab(lastRun.sessionId);
                    }}
                    className="mt-2 inline-flex items-center gap-1 text-yellow-400 hover:text-yellow-300"
                  >
                    <ExternalLink size={14} />
                    Open session {lastRun.sessionId.slice(0, 8)}…
                  </a>
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm text-neutral-500">Select a plan to see its phases.</div>
          )}
        </div>
      </div>
    </div>
  );
};
