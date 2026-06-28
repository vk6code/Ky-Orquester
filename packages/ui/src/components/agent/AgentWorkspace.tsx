import React, { useEffect, useMemo, useState } from "react";
import { ArrowUp, Bot, Folder, FolderOpen, Loader2, Play, Plus, X } from "lucide-react";
import type { FsEntry } from "@orquester/api";
import { cn } from "../../lib/cn";
import { useApi } from "../../context/orquester-context";
import { useRegistry } from "../../hooks";
import { useAppStore } from "../../store/app";
import { getRegistryIcon } from "../../icons";
import { Button, Input, Modal, ModalCloseButton } from "../ui";

const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

/**
 * Agent workspace launcher: pick a base directory anywhere on the server and
 * attach extra working directories (e.g. frontend + backend) so a single agent
 * spans several roots. Agents that declare an `addDirFlag` (Claude Code:
 * `--add-dir`) receive the dirs as launch args; others ignore them.
 */
export const AgentWorkspace: React.FC = () => {
  const registry = useRegistry();
  const currentProject = useAppStore((s) => s.currentProject);
  const launchAgentWorkspace = useAppStore((s) => s.launchAgentWorkspace);

  const agents = useMemo(() => registry.agents.filter((a) => a.enabled), [registry.agents]);

  const [refId, setRefId] = useState<string>("");
  const [baseDir, setBaseDir] = useState(currentProject?.path ?? "");
  const [extraDirs, setExtraDirs] = useState<string[]>([]);
  const [picker, setPicker] = useState<null | { mode: "base" | "extra" }>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default the agent to the first one that supports multi-root, else the first.
  useEffect(() => {
    if (refId && agents.some((a) => a.id === refId)) {
      return;
    }
    const preferred = agents.find((a) => a.addDirFlag) ?? agents[0];
    if (preferred) {
      setRefId(preferred.id);
    }
  }, [agents, refId]);

  useEffect(() => {
    if (!baseDir && currentProject?.path) {
      setBaseDir(currentProject.path);
    }
  }, [currentProject?.path, baseDir]);

  const selectedAgent = agents.find((a) => a.id === refId);
  const supportsMultiRoot = Boolean(selectedAgent?.addDirFlag);
  const canLaunch = Boolean(refId && baseDir.trim() && !running);

  const addExtraDir = (dir: string) => {
    setExtraDirs((prev) => (prev.includes(dir) ? prev : [...prev, dir]));
  };
  const removeExtraDir = (dir: string) => setExtraDirs((prev) => prev.filter((d) => d !== dir));

  const onPick = (dir: string) => {
    if (picker?.mode === "base") {
      setBaseDir(dir);
    } else {
      addExtraDir(dir);
    }
    setPicker(null);
  };

  const launch = async () => {
    if (!canLaunch) {
      return;
    }
    setError(null);
    setRunning(true);
    try {
      await launchAgentWorkspace({
        refId,
        title: selectedAgent?.name,
        cwd: baseDir.trim(),
        extraDirs: supportsMultiRoot ? extraDirs.map((d) => d.trim()).filter(Boolean) : []
      });
    } catch (launchError) {
      setError(launchError instanceof Error ? launchError.message : "Failed to launch agent.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-6 text-neutral-200">
      <h2 className="flex items-center gap-2 text-xl font-semibold">
        <Bot size={22} className="text-cyan-400" />
        Agent workspace
      </h2>
      <p className="max-w-3xl text-sm text-neutral-400">
        Launch a coding agent with a base directory plus any number of extra working directories
        (e.g. a <span className="text-neutral-200">frontend</span> and a{" "}
        <span className="text-neutral-200">backend</span>). The agent gets all of them as roots.
      </p>

      {error && (
        <div className="rounded-md border border-red-900/60 bg-red-950/40 p-3 text-sm text-red-200">{error}</div>
      )}

      <div className="max-w-2xl space-y-4 rounded-xl border border-neutral-800 bg-neutral-900/70 p-4">
        {/* Agent */}
        <label className="block space-y-1">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">Agent</span>
          {agents.length === 0 ? (
            <p className="text-sm text-neutral-500">No agents installed. Install one in Settings → Agents.</p>
          ) : (
            <select
              value={refId}
              onChange={(event) => setRefId(event.target.value)}
              className="h-9 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 text-sm text-neutral-100 outline-none focus:ring-1 focus:ring-neutral-500"
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                  {agent.addDirFlag ? "" : " (single directory)"}
                </option>
              ))}
            </select>
          )}
        </label>

        {/* Base directory */}
        <label className="block space-y-1">
          <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
            <FolderOpen size={13} />
            Base directory
          </span>
          <div className="flex gap-2">
            <Input
              value={baseDir}
              onChange={(event) => setBaseDir(event.target.value)}
              placeholder="/absolute/path"
            />
            <Button variant="outline" size="sm" onClick={() => setPicker({ mode: "base" })}>
              <Folder size={14} />
              Browse
            </Button>
          </div>
          <span className="text-[11px] text-neutral-500">Where the agent process starts (its cwd).</span>
        </label>

        {/* Extra directories */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
              Working directories
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={!supportsMultiRoot}
              onClick={() => setPicker({ mode: "extra" })}
            >
              <Plus size={14} />
              Add directory
            </Button>
          </div>

          {!supportsMultiRoot && (
            <p className="rounded-md border border-amber-900/50 bg-amber-950/30 p-2 text-[11px] text-amber-200">
              {selectedAgent?.name ?? "This agent"} has no multi-root support — extra directories are ignored.
            </p>
          )}

          {extraDirs.length === 0 ? (
            <p className="rounded-lg border border-dashed border-neutral-800 p-3 text-sm text-neutral-500">
              No extra directories. Add a frontend and a backend to work on both at once.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {extraDirs.map((dir) => (
                <li
                  key={dir}
                  className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-950/60 px-3 py-1.5 text-sm"
                >
                  <Folder size={14} className="shrink-0 text-neutral-500" />
                  <span className="flex-1 truncate" title={dir}>
                    <span className="text-neutral-100">{baseName(dir)}</span>
                    <span className="ml-2 text-[11px] text-neutral-500">{dir}</span>
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${dir}`}
                    onClick={() => removeExtraDir(dir)}
                    className="flex h-6 w-6 items-center justify-center rounded text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 pt-1">
          <div className="flex items-center gap-2 text-xs text-neutral-500">
            {selectedAgent && getRegistryIcon("agent", selectedAgent.id, 14)}
            {supportsMultiRoot && extraDirs.length > 0
              ? `${extraDirs.length} extra dir${extraDirs.length > 1 ? "s" : ""} via ${selectedAgent?.addDirFlag}`
              : "Single root"}
          </div>
          <Button onClick={() => void launch()} disabled={!canLaunch}>
            {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            Launch agent
          </Button>
        </div>
      </div>

      <DirPickerModal
        open={picker !== null}
        startDir={picker?.mode === "extra" ? baseDir || currentProject?.path || "/" : baseDir || "/"}
        onPick={onPick}
        onClose={() => setPicker(null)}
      />
    </div>
  );
};

/** Modal directory browser: navigate folders and select one. */
const DirPickerModal: React.FC<{
  open: boolean;
  startDir: string;
  onPick: (dir: string) => void;
  onClose: () => void;
}> = ({ open, startDir, onPick, onClose }) => {
  const api = useApi();
  const [dir, setDir] = useState(startDir);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDir(startDir || "/");
    }
  }, [open, startDir]);

  useEffect(() => {
    if (!open || !dir) {
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    api
      .listFiles(dir)
      .then((res) => {
        if (!active) return;
        setParent(res.parent);
        setEntries(res.entries.filter((e) => e.kind === "dir"));
      })
      .catch(() => active && setError("Cannot read this directory."))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [api, dir, open]);

  return (
    <Modal open={open} onClose={onClose} className="max-w-xl">
      <div className="flex w-full flex-col">
        <div className="flex h-11 items-center gap-2 border-b border-neutral-800 px-3">
          <Folder size={15} className="text-cyan-400" />
          <span className="flex-1 truncate text-sm text-neutral-300" title={dir}>
            {dir}
          </span>
          <ModalCloseButton onClose={onClose} />
        </div>

        <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!parent || parent === dir}
            onClick={() => parent && setDir(parent)}
          >
            <ArrowUp size={14} />
            Up
          </Button>
          <Input value={dir} onChange={(event) => setDir(event.target.value)} placeholder="/absolute/path" />
        </div>

        <div className="max-h-[50vh] min-h-[12rem] flex-1 overflow-auto py-1">
          {loading && <p className="px-3 py-2 text-xs text-neutral-600">Loading…</p>}
          {error && <p className="px-3 py-2 text-xs text-red-400">{error}</p>}
          {!loading && !error && entries.length === 0 && (
            <p className="px-3 py-2 text-xs text-neutral-600">No sub-directories.</p>
          )}
          {entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => setDir(entry.path)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-neutral-300",
                "hover:bg-neutral-800/70"
              )}
            >
              <Folder size={14} className="shrink-0 text-neutral-500" />
              <span className="flex-1 truncate">{entry.name}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-neutral-800 px-3 py-2.5">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => onPick(dir)} disabled={!dir.trim()}>
            Select this directory
          </Button>
        </div>
      </div>
    </Modal>
  );
};
