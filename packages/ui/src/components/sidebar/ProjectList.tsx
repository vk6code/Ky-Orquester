import React, { useState } from "react";
import {
  Box,
  ChevronLeft,
  FolderPlus,
  FolderSymlink,
  PanelLeftClose,
  Pencil,
  Plus,
  Banana,
  Workflow
} from "lucide-react";
import { cn } from "../../lib/cn";
import { Dropdown, DropdownItem, IconButton } from "../ui";
import { FolderPickerModal } from "../files";
import { NewItemInput } from "./NewItemInput";
import { useAppStore } from "../../store/app";

const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

/** Sidebar view shown after entering a workspace: its projects. */
export const ProjectList: React.FC = () => {
  const currentWorkspace = useAppStore((s) => s.currentWorkspace);
  const currentProject = useAppStore((s) => s.currentProject);
  const projects = useAppStore((s) => s.projects);
  const workspaces = useAppStore((s) => s.workspaces);
  const labels = useAppStore((s) => s.labels);
  const loading = useAppStore((s) => s.projectsLoading);
  const closeWorkspace = useAppStore((s) => s.closeWorkspace);
  const openProject = useAppStore((s) => s.openProject);
  const createProject = useAppStore((s) => s.createProject);
  const setLabel = useAppStore((s) => s.setLabel);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const openGorila360Plans = useAppStore((s) => s.openGorila360Plans);
  const openLoopRunner = useAppStore((s) => s.openLoopRunner);
  const [creating, setCreating] = useState<null | "project" | "folder">(null);
  const [editing, setEditing] = useState<string | null>(null);
  // The header shows the current workspace; resolve its display label by path.
  const workspacePath = workspaces.find((w) => w.name === currentWorkspace)?.path;
  // Linking an external server folder as a project (symlink under the workspace).
  const [linkPicking, setLinkPicking] = useState(false);
  const [linkPath, setLinkPath] = useState<string | null>(null);

  return (
    <>
      <div className="flex h-9 items-center gap-0.5 px-2">
        <IconButton label="Collapse sidebar" className="hidden md:flex" onClick={toggleSidebar}>
          <PanelLeftClose size={15} />
        </IconButton>
        <IconButton label="Back to workspaces" onClick={closeWorkspace}>
          <ChevronLeft size={16} />
        </IconButton>
        <span className="flex-1 truncate text-sm font-medium text-neutral-100">
          {(workspacePath && labels[workspacePath]) || currentWorkspace}
        </span>
        <Dropdown
          trigger={
            <IconButton label="New">
              <Plus size={16} />
            </IconButton>
          }
          align="right"
          width="w-44"
        >
          <DropdownItem icon={<Box size={14} />} onClick={() => setCreating("project")}>
            New Project
          </DropdownItem>
          <DropdownItem icon={<FolderPlus size={14} />} onClick={() => setCreating("folder")}>
            New Folder
          </DropdownItem>
          <DropdownItem icon={<FolderSymlink size={14} />} onClick={() => setLinkPicking(true)}>
            Link folder…
          </DropdownItem>
        </Dropdown>
      </div>

      <nav className="flex-1 space-y-px overflow-y-auto px-2 pb-2">
        {creating && (
          <NewItemInput
            placeholder={creating === "folder" ? "folder-name" : "project-name"}
            onCancel={() => setCreating(null)}
            onSubmit={(name) => {
              setCreating(null);
              void createProject(name);
            }}
          />
        )}

        {linkPath !== null && (
          <NewItemInput
            placeholder="project-name"
            defaultValue={baseName(linkPath)}
            onCancel={() => setLinkPath(null)}
            onSubmit={(name) => {
              const target = linkPath;
              setLinkPath(null);
              void createProject(name, target ?? undefined);
            }}
          />
        )}

        {loading && projects.length === 0 && (
          <p className="px-2 py-2 text-xs text-neutral-600">Loading…</p>
        )}
        {!loading && projects.length === 0 && !creating && (
          <p className="px-2 py-2 text-xs text-neutral-600">No projects yet</p>
        )}
        {projects.map((project) =>
          editing === project.path ? (
            <NewItemInput
              key={project.path}
              placeholder="display-name"
              defaultValue={labels[project.path] ?? project.name}
              onCancel={() => setEditing(null)}
              onSubmit={(name) => {
                setEditing(null);
                void setLabel(project.path, name);
              }}
            />
          ) : (
            <div key={project.path} className="group flex items-center">
              <button
                type="button"
                onClick={() => openProject(project)}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                  project.path === currentProject?.path
                    ? "bg-neutral-800 text-neutral-100"
                    : "text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
                )}
              >
                <Box size={15} className="text-neutral-500" />
                <span className="flex-1 truncate">{labels[project.path] ?? project.name}</span>
              </button>
              <button
                type="button"
                aria-label="Rename project"
                className="ml-0.5 hidden h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 group-hover:flex"
                onClick={() => setEditing(project.path)}
              >
                <Pencil size={13} />
              </button>
            </div>
          )
        )}
      </nav>

      {currentProject && (
        <div className="border-t border-neutral-800 p-2 space-y-2">
          <button
            type="button"
            onClick={openLoopRunner}
            className="flex w-full items-center gap-2 rounded-md bg-cyan-600/10 px-2 py-1.5 text-left text-sm font-medium text-cyan-300 transition-colors hover:bg-cyan-600/20"
          >
            <Workflow size={15} />
            <span className="flex-1 truncate">Loop Runner</span>
          </button>
          <button
            type="button"
            onClick={openGorila360Plans}
            className="flex w-full items-center gap-2 rounded-md bg-yellow-600/10 px-2 py-1.5 text-left text-sm font-medium text-yellow-500 transition-colors hover:bg-yellow-600/20"
          >
            <Banana size={15} />
            <span className="flex-1 truncate">Gorila360 Plans</span>
          </button>
        </div>
      )}

      <FolderPickerModal
        open={linkPicking}
        title="Link a server folder as a project"
        confirmLabel="Use this folder"
        startDir="/"
        onPick={(dir) => {
          setLinkPicking(false);
          setLinkPath(dir);
        }}
        onClose={() => setLinkPicking(false)}
      />
    </>
  );
};
