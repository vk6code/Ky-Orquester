import React from "react";
import { ChevronDown, Code2, ExternalLink, FolderOpen, Globe } from "lucide-react";
import { Dropdown, DropdownEmpty, DropdownItem, DropdownLabel, DropdownSeparator } from "../ui";
import { useRegistry } from "../../hooks";
import { useApi } from "../../context/orquester-context";
import { useAppStore } from "../../store/app";
import type { RegistryEntry } from "../../types";

/**
 * "Open on ▾" — launch the current project folder in a detected IDE, file
 * explorer or browser (real daemon registry). Falls back to the OS default
 * ("Open Directory" / "Default Browser") entries the daemon always provides.
 */
export const OpenOnMenu: React.FC = () => {
  const api = useApi();
  const currentProject = useAppStore((s) => s.currentProject);
  const { data: registry, loading } = useRegistry();

  const open = (target: RegistryEntry) => {
    if (currentProject) {
      void api.open(target.id, currentProject.path);
    }
  };

  const section = (label: string, icon: React.ReactNode, entries: RegistryEntry[], emptyText: string) => {
    const available = entries.filter((e) => e.enabled);
    return (
      <>
        <DropdownLabel>{label}</DropdownLabel>
        {loading && <DropdownEmpty>Loading…</DropdownEmpty>}
        {!loading && available.length === 0 && <DropdownEmpty>{emptyText}</DropdownEmpty>}
        {available.map((entry) => (
          <DropdownItem key={entry.id} icon={icon} onClick={() => open(entry)}>
            {entry.name}
          </DropdownItem>
        ))}
      </>
    );
  };

  const trigger = (
    <span className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-neutral-300 hover:bg-neutral-800">
      <ExternalLink size={13} className="text-neutral-500" />
      Open on
      <ChevronDown size={13} className="text-neutral-500" />
    </span>
  );

  return (
    <Dropdown trigger={trigger} align="right" width="w-56">
      {section("Editors", <Code2 size={14} />, registry.ides, "No editors detected")}
      <DropdownSeparator />
      {section("File explorers", <FolderOpen size={14} />, registry.fileExplorers, "Unavailable")}
      <DropdownSeparator />
      {section("Browsers", <Globe size={14} />, registry.browsers, "No browsers detected")}
    </Dropdown>
  );
};
