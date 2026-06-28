import React, { useEffect, useState } from "react";
import { ArrowUp, Folder, HardDrive } from "lucide-react";
import { DirectoryTree } from "./DirectoryTree";
import { Button, Input, Modal, ModalCloseButton } from "../ui";

const parentOf = (p: string) => {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i <= 0 ? "/" : t.slice(0, i);
};

/**
 * Modal directory picker: an expandable folder tree you can re-root anywhere on
 * the server (filesystem root, up one level, or type an absolute path), then
 * click a folder to select it.
 */
export const FolderPickerModal: React.FC<{
  open: boolean;
  startDir: string;
  title?: string;
  confirmLabel?: string;
  onPick: (dir: string) => void;
  onClose: () => void;
}> = ({ open, startDir, title = "Select a directory", confirmLabel = "Select", onPick, onClose }) => {
  const [root, setRoot] = useState(startDir || "/");
  const [pathInput, setPathInput] = useState(startDir || "/");
  const [selected, setSelected] = useState(startDir || "/");

  useEffect(() => {
    if (open) {
      const s = startDir || "/";
      setRoot(s);
      setPathInput(s);
      setSelected(s);
    }
  }, [open, startDir]);

  const goTo = (path: string) => {
    const v = (path.trim() || "/").replace(/(?!^)\/+$/, "");
    setRoot(v);
    setPathInput(v);
    setSelected(v);
  };

  return (
    <Modal open={open} onClose={onClose} className="max-w-xl">
      <div className="flex w-full flex-col">
        <div className="flex h-11 items-center gap-2 border-b border-neutral-800 px-3">
          <Folder size={15} className="text-cyan-400" />
          <span className="flex-1 text-sm text-neutral-300">{title}</span>
          <ModalCloseButton onClose={onClose} />
        </div>

        <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
          <Button variant="outline" size="sm" onClick={() => goTo("/")} title="Filesystem root">
            <HardDrive size={14} />/
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={root === "/"}
            onClick={() => goTo(parentOf(root))}
            title="Up one level"
          >
            <ArrowUp size={14} />
          </Button>
          <Input
            value={pathInput}
            onChange={(event) => setPathInput(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && goTo(pathInput)}
            placeholder="/home/srv"
          />
          <Button variant="outline" size="sm" onClick={() => goTo(pathInput)}>
            Go
          </Button>
        </div>

        <div className="max-h-[55vh] min-h-[14rem] flex-1 overflow-auto p-2">
          <DirectoryTree rootPath={root} selectedPath={selected} onSelect={setSelected} showFiles />
        </div>

        <div className="flex items-center gap-2 border-t border-neutral-800 px-3 py-2.5">
          <span className="flex-1 truncate text-xs text-neutral-500" title={selected}>
            <span className="text-neutral-600">Selected:</span> {selected}
          </span>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => onPick(selected)} disabled={!selected.trim()}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
