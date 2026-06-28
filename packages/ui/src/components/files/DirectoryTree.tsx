import React, { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, Loader2 } from "lucide-react";
import type { FsEntry } from "@orquester/api";
import { cn } from "../../lib/cn";
import { useApi } from "../../context/orquester-context";

const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

/**
 * Expandable filesystem tree with single folder selection. Lazily loads children
 * from /api/fs as folders are expanded. Clicking a folder name selects it;
 * clicking the chevron expands/collapses. With `showFiles`, files are listed too
 * (muted, non-selectable) so it reads like a real explorer. Re-roots on `rootPath`.
 */
export const DirectoryTree: React.FC<{
  rootPath: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** Also show files (as muted, non-selectable leaves) for context. */
  showFiles?: boolean;
}> = ({ rootPath, selectedPath, onSelect, showFiles = false }) => {
  const api = useApi();
  const [childrenByPath, setChildrenByPath] = useState<Record<string, FsEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());

  const loadDir = useCallback(
    async (dir: string) => {
      setLoading((s) => new Set(s).add(dir));
      try {
        const res = await api.listFiles(dir);
        setChildrenByPath((prev) => ({ ...prev, [dir]: res.entries }));
      } catch {
        setChildrenByPath((prev) => ({ ...prev, [dir]: [] }));
      } finally {
        setLoading((s) => {
          const n = new Set(s);
          n.delete(dir);
          return n;
        });
      }
    },
    [api]
  );

  useEffect(() => {
    setExpanded(new Set([rootPath]));
    setChildrenByPath({});
    void loadDir(rootPath);
  }, [rootPath, loadDir]);

  const toggle = (dir: string) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(dir)) {
        n.delete(dir);
      } else {
        n.add(dir);
        if (!childrenByPath[dir]) {
          void loadDir(dir);
        }
      }
      return n;
    });
  };

  const Row: React.FC<{ path: string; label: string; depth: number; isRoot?: boolean }> = ({
    path,
    label,
    depth,
    isRoot
  }) => {
    const isOpen = expanded.has(path);
    const isSelected = path === selectedPath;
    const isLoading = loading.has(path);
    return (
      <div
        className={cn(
          "flex items-center gap-1 rounded-sm pr-2 text-sm",
          isSelected ? "bg-cyan-500/20 text-cyan-100" : "text-neutral-300 hover:bg-neutral-800/60"
        )}
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        <button
          type="button"
          aria-label={isOpen ? "Collapse" : "Expand"}
          onClick={() => toggle(path)}
          className="flex h-6 w-5 shrink-0 items-center justify-center text-neutral-500 hover:text-neutral-200"
        >
          {isLoading ? (
            <Loader2 size={12} className="animate-spin" />
          ) : isOpen ? (
            <ChevronDown size={13} />
          ) : (
            <ChevronRight size={13} />
          )}
        </button>
        <button
          type="button"
          onClick={() => onSelect(path)}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
          title={path}
        >
          {isOpen ? (
            <FolderOpen size={14} className="shrink-0 text-cyan-400/80" />
          ) : (
            <Folder size={14} className="shrink-0 text-neutral-500" />
          )}
          <span className="truncate">{isRoot ? path : label}</span>
        </button>
      </div>
    );
  };

  const FileRow: React.FC<{ name: string; depth: number }> = ({ name, depth }) => (
    <div
      className="flex items-center gap-1.5 py-0.5 text-sm text-neutral-500"
      style={{ paddingLeft: 4 + depth * 14 + 20 }}
      title={name}
    >
      <File size={13} className="shrink-0 text-neutral-600" />
      <span className="truncate">{name}</span>
    </div>
  );

  const renderChildren = (dir: string, depth: number): React.ReactNode => {
    if (!expanded.has(dir)) {
      return null;
    }
    const kids = childrenByPath[dir];
    if (!kids) {
      return null; // loading shown on the parent row's spinner
    }
    const dirs = kids.filter((e) => e.kind === "dir");
    const files = showFiles ? kids.filter((e) => e.kind === "file") : [];
    if (dirs.length === 0 && files.length === 0) {
      return (
        <p className="py-0.5 text-xs text-neutral-600" style={{ paddingLeft: 4 + (depth + 1) * 14 + 20 }}>
          (empty)
        </p>
      );
    }
    return (
      <>
        {dirs.map((entry) => (
          <React.Fragment key={entry.path}>
            <Row path={entry.path} label={entry.name} depth={depth} />
            {renderChildren(entry.path, depth + 1)}
          </React.Fragment>
        ))}
        {files.map((entry) => (
          <FileRow key={entry.path} name={entry.name} depth={depth} />
        ))}
      </>
    );
  };

  return (
    <div className="select-none">
      <Row path={rootPath} label={baseName(rootPath)} depth={0} isRoot />
      {renderChildren(rootPath, 1)}
    </div>
  );
};
