import React, { useState } from "react";
import { Folder, FolderPlus, PanelLeftClose, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { IconButton } from "../ui";
import { NewItemInput } from "./NewItemInput";
import { useAppStore } from "../../store/app";

/** Root sidebar view: the list of workspace folders. */
export const WorkspaceList: React.FC = () => {
  const workspaces = useAppStore((s) => s.workspaces);
  const labels = useAppStore((s) => s.labels);
  const hidden = useAppStore((s) => s.hidden);
  const loading = useAppStore((s) => s.workspacesLoading);
  const openWorkspace = useAppStore((s) => s.openWorkspace);
  const createWorkspace = useAppStore((s) => s.createWorkspace);
  const setLabel = useAppStore((s) => s.setLabel);
  const setHidden = useAppStore((s) => s.setHidden);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  const visible = workspaces.filter((w) => !hidden.includes(w.path));
  const hiddenWorkspaces = workspaces.filter((w) => hidden.includes(w.path));

  return (
    <>
      <div className="flex h-9 items-center gap-1 px-2">
        <IconButton label="Collapse sidebar" className="hidden md:flex" onClick={toggleSidebar}>
          <PanelLeftClose size={15} />
        </IconButton>
        <span className="flex-1 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
          Workspaces
        </span>
        <IconButton label="New workspace" onClick={() => setCreating(true)}>
          <FolderPlus size={15} />
        </IconButton>
      </div>

      <nav className="flex-1 space-y-px overflow-y-auto px-2 pb-2">
        {creating && (
          <NewItemInput
            placeholder="workspace-name"
            onCancel={() => setCreating(false)}
            onSubmit={(name) => {
              setCreating(false);
              void createWorkspace(name);
            }}
          />
        )}

        {loading && workspaces.length === 0 && (
          <p className="px-2 py-2 text-xs text-neutral-600">Loading…</p>
        )}
        {!loading && visible.length === 0 && !creating && (
          <p className="px-2 py-2 text-xs text-neutral-600">No workspaces yet</p>
        )}
        {visible.map((workspace) =>
          editing === workspace.path ? (
            <NewItemInput
              key={workspace.path}
              placeholder="display-name"
              defaultValue={labels[workspace.path] ?? workspace.name}
              onCancel={() => setEditing(null)}
              onSubmit={(name) => {
                setEditing(null);
                void setLabel(workspace.path, name);
              }}
            />
          ) : (
            <div key={workspace.path} className="group flex items-center">
              <button
                type="button"
                onClick={() => void openWorkspace(workspace.name)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
              >
                <Folder size={15} className="text-neutral-500" />
                <span className="flex-1 truncate">{labels[workspace.path] ?? workspace.name}</span>
                <span className="text-xs text-neutral-600">{workspace.projectCount}</span>
              </button>
              <button
                type="button"
                aria-label="Rename workspace"
                className="ml-0.5 hidden h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 group-hover:flex"
                onClick={() => setEditing(workspace.path)}
              >
                <Pencil size={13} />
              </button>
              <button
                type="button"
                aria-label="Remove from Orquester"
                title="Remove from Orquester (does not delete files)"
                className="hidden h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-red-400 group-hover:flex"
                onClick={() => void setHidden(workspace.path, true)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          )
        )}

        {hiddenWorkspaces.length > 0 && (
          <div className="pt-2">
            <button
              type="button"
              onClick={() => setShowHidden((v) => !v)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] text-neutral-600 hover:text-neutral-400"
            >
              <Trash2 size={12} />
              <span className="flex-1">Removed ({hiddenWorkspaces.length})</span>
              <span>{showHidden ? "hide" : "show"}</span>
            </button>
            {showHidden &&
              hiddenWorkspaces.map((workspace) => (
                <div key={workspace.path} className="group flex items-center opacity-60">
                  <span className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-sm text-neutral-400">
                    <Folder size={15} className="text-neutral-600" />
                    <span className="flex-1 truncate">
                      {labels[workspace.path] ?? workspace.name}
                    </span>
                  </span>
                  <button
                    type="button"
                    aria-label="Restore"
                    title="Restore to Orquester"
                    className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-emerald-400"
                    onClick={() => void setHidden(workspace.path, false)}
                  >
                    <RotateCcw size={13} />
                  </button>
                </div>
              ))}
          </div>
        )}
      </nav>
    </>
  );
};
