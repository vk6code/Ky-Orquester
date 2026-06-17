import type {
  OpenResult,
  RegistryActionResult,
  RegistryEntry,
  RegistryKind,
  RegistryResponse
} from "@orquester/api";
import { exec, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

/** A registry definition before PATH resolution. */
interface RegistryDef {
  id: string;
  name: string;
  kind: RegistryKind;
  bin: string[];
  /** Explicitly disable even when a bin is found. */
  enabled?: boolean;
  versionFlag?: string;
  installCmd?: string;
  updateCmd?: string;
}

// Common install roots used to build absolute candidate paths. Non-matching
// platforms simply won't resolve those candidates.
const LOCALAPPDATA = process.env.LOCALAPPDATA;
const PROGRAM_FILES = process.env.ProgramFiles;

/** Drop empty/undefined candidates. */
function bins(...candidates: Array<string | undefined | false>): string[] {
  return candidates.filter((c): c is string => typeof c === "string" && c.length > 0);
}

// Hardcoded defaults. Extend/override via <daemonDir>/{shells,agents,ides,file-explorers,browsers}.json.
const DEFAULT_SHELLS: RegistryDef[] = [
  { id: "bash", name: "Bash", kind: "shell", bin: ["bash"] },
  { id: "zsh", name: "Zsh", kind: "shell", bin: ["zsh"] },
  { id: "fish", name: "Fish", kind: "shell", bin: ["fish"] },
  { id: "nu", name: "Nushell", kind: "shell", bin: ["nu"] },
  { id: "pwsh", name: "PowerShell", kind: "shell", bin: ["pwsh", "powershell"] },
  { id: "cmd", name: "Command Prompt", kind: "shell", bin: ["cmd"] },
  { id: "sh", name: "sh", kind: "shell", bin: ["sh"] }
];

const DEFAULT_AGENTS: RegistryDef[] = [
  {
    id: "claude",
    name: "Claude Code",
    kind: "agent",
    bin: ["claude"],
    versionFlag: "--version",
    installCmd: "npm install -g @anthropic-ai/claude-code",
    updateCmd: "npm update -g @anthropic-ai/claude-code"
  },
  {
    id: "codex",
    name: "Codex",
    kind: "agent",
    bin: ["codex"],
    versionFlag: "--version",
    installCmd: "npm install -g @openai/codex",
    updateCmd: "npm update -g @openai/codex"
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    kind: "agent",
    bin: ["gemini"],
    versionFlag: "--version",
    installCmd: "npm install -g @google/gemini-cli",
    updateCmd: "npm update -g @google/gemini-cli"
  },
  {
    id: "opencode",
    name: "OpenCode",
    kind: "agent",
    bin: ["opencode"],
    versionFlag: "--version",
    installCmd: "npm install -g opencode-ai",
    updateCmd: "npm update -g opencode-ai"
  },
  {
    id: "aider",
    name: "Aider",
    kind: "agent",
    bin: ["aider"],
    versionFlag: "--version",
    installCmd: "pipx install aider-chat",
    updateCmd: "pipx upgrade aider-chat"
  }
];

const DEFAULT_IDES: RegistryDef[] = [
  {
    id: "vscode",
    name: "VS Code",
    kind: "ide",
    bin: bins(
      "code",
      "code-insiders",
      "/usr/bin/code",
      "/usr/share/code/bin/code",
      "/snap/bin/code",
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      LOCALAPPDATA && `${LOCALAPPDATA}\\Programs\\Microsoft VS Code\\bin\\code.cmd`,
      PROGRAM_FILES && `${PROGRAM_FILES}\\Microsoft VS Code\\bin\\code.cmd`
    )
  },
  {
    id: "cursor",
    name: "Cursor",
    kind: "ide",
    bin: bins(
      "cursor",
      "/usr/bin/cursor",
      "/usr/share/cursor/bin/cursor",
      "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
      LOCALAPPDATA && `${LOCALAPPDATA}\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd`
    )
  },
  {
    id: "antigravity",
    name: "Antigravity",
    kind: "ide",
    bin: bins(
      "antigravity",
      "/usr/bin/antigravity",
      "/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity",
      LOCALAPPDATA && `${LOCALAPPDATA}\\Programs\\Antigravity\\bin\\antigravity.cmd`
    )
  },
  {
    id: "windsurf",
    name: "Windsurf",
    kind: "ide",
    bin: bins("windsurf", "/usr/bin/windsurf", "/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf")
  },
  {
    id: "zed",
    name: "Zed",
    kind: "ide",
    bin: bins("zed", "zeditor", "/usr/bin/zed", "/Applications/Zed.app/Contents/MacOS/cli")
  },
  {
    id: "intellij",
    name: "IntelliJ IDEA",
    kind: "ide",
    bin: bins("idea", "idea.sh", "/Applications/IntelliJ IDEA.app/Contents/MacOS/idea")
  },
  { id: "sublime", name: "Sublime Text", kind: "ide", bin: bins("subl", "/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl") }
];

const DEFAULT_FILE_EXPLORERS: RegistryDef[] = [
  { id: "nautilus", name: "Files (Nautilus)", kind: "file-explorer", bin: ["nautilus"] },
  { id: "dolphin", name: "Dolphin", kind: "file-explorer", bin: ["dolphin"] },
  { id: "thunar", name: "Thunar", kind: "file-explorer", bin: ["thunar"] },
  { id: "nemo", name: "Nemo", kind: "file-explorer", bin: ["nemo"] },
  { id: "pcmanfm", name: "PCManFM", kind: "file-explorer", bin: ["pcmanfm"] },
  { id: "caja", name: "Caja", kind: "file-explorer", bin: ["caja"] },
  // OS default fallback (Finder / Explorer / xdg-open).
  { id: "system-files", name: "Open Directory", kind: "file-explorer", bin: osOpener() }
];

const DEFAULT_BROWSERS: RegistryDef[] = [
  {
    id: "chrome",
    name: "Google Chrome",
    kind: "browser",
    bin: bins(
      "google-chrome",
      "google-chrome-stable",
      "chrome",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      PROGRAM_FILES && `${PROGRAM_FILES}\\Google\\Chrome\\Application\\chrome.exe`
    )
  },
  { id: "chromium", name: "Chromium", kind: "browser", bin: bins("chromium", "chromium-browser") },
  {
    id: "firefox",
    name: "Firefox",
    kind: "browser",
    bin: bins("firefox", "/Applications/Firefox.app/Contents/MacOS/firefox", PROGRAM_FILES && `${PROGRAM_FILES}\\Mozilla Firefox\\firefox.exe`)
  },
  {
    id: "brave",
    name: "Brave",
    kind: "browser",
    bin: bins("brave-browser", "brave", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser")
  },
  {
    id: "edge",
    name: "Microsoft Edge",
    kind: "browser",
    bin: bins("microsoft-edge", "microsoft-edge-stable", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")
  },
  { id: "vivaldi", name: "Vivaldi", kind: "browser", bin: bins("vivaldi", "vivaldi-stable") },
  // OS default fallback.
  { id: "system-browser", name: "Default Browser", kind: "browser", bin: osOpener() }
];

/** The platform's generic "open this" command. */
function osOpener(): string[] {
  if (process.platform === "win32") {
    return ["explorer"];
  }
  if (process.platform === "darwin") {
    return ["open"];
  }
  return ["xdg-open"];
}

/** Resolve the first candidate that exists as an executable on PATH. */
function resolveBin(candidates: string[]): string | undefined {
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];

  for (const candidate of candidates) {
    if (isAbsolute(candidate)) {
      if (isExecutable(candidate)) {
        return candidate;
      }
      continue;
    }

    for (const dir of pathDirs) {
      for (const ext of exts) {
        const full = join(dir, candidate + ext);
        if (isExecutable(full)) {
          return full;
        }
      }
    }
  }

  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Owns the catalog of launchable shells, agents, IDEs, file explorers and
 * browsers. Resolves each entry's binary against PATH (and common install
 * paths) once and caches it; an entry is `enabled` only when a candidate bin
 * was found (and it was not explicitly disabled).
 */
export class RegistryService {
  private entries = new Map<string, RegistryEntry>();

  constructor(private readonly daemonDir: string) {}

  async init(): Promise<void> {
    const defs: RegistryDef[] = [
      ...DEFAULT_SHELLS,
      ...DEFAULT_AGENTS,
      ...DEFAULT_IDES,
      ...DEFAULT_FILE_EXPLORERS,
      ...DEFAULT_BROWSERS,
      ...(await this.loadOverrides("shells.json", "shell")),
      ...(await this.loadOverrides("agents.json", "agent")),
      ...(await this.loadOverrides("ides.json", "ide")),
      ...(await this.loadOverrides("file-explorers.json", "file-explorer")),
      ...(await this.loadOverrides("browsers.json", "browser"))
    ];

    this.entries.clear();
    for (const def of defs) {
      this.entries.set(def.id, this.resolveDef(def));
    }
  }

  list(): RegistryResponse {
    const byKind = (kind: RegistryKind) =>
      [...this.entries.values()].filter((entry) => entry.kind === kind);
    return {
      shells: byKind("shell"),
      agents: byKind("agent"),
      ides: byKind("ide"),
      fileExplorers: byKind("file-explorer"),
      browsers: byKind("browser")
    };
  }

  get(id: string): RegistryEntry | undefined {
    return this.entries.get(id);
  }

  /** Launch an ide/file-explorer/browser on a path (fire-and-forget). */
  openTarget(targetId: string, path: string): OpenResult {
    const entry = this.entries.get(targetId);
    if (!entry?.resolvedBin || !entry.enabled) {
      return { ok: false, message: `Target "${targetId}" is not available.` };
    }

    const arg = entry.kind === "browser" ? pathToFileURL(path).href : path;
    try {
      const child = spawn(entry.resolvedBin, [arg], { detached: true, stdio: "ignore" });
      child.unref();
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "spawn failed" };
    }
  }

  async version(id: string): Promise<RegistryActionResult> {
    const entry = this.entries.get(id);
    if (!entry?.resolvedBin || !entry.versionFlag) {
      return { ok: false, exitCode: -1, output: "No bin or version flag for this entry." };
    }
    return run(`"${entry.resolvedBin}" ${entry.versionFlag}`);
  }

  async install(id: string): Promise<RegistryActionResult> {
    const entry = this.entries.get(id);
    if (!entry?.installCmd) {
      return { ok: false, exitCode: -1, output: "No install command for this entry." };
    }
    const result = await run(entry.installCmd);
    await this.init();
    return result;
  }

  async update(id: string): Promise<RegistryActionResult> {
    const entry = this.entries.get(id);
    if (!entry?.updateCmd) {
      return { ok: false, exitCode: -1, output: "No update command for this entry." };
    }
    return run(entry.updateCmd);
  }

  private resolveDef(def: RegistryDef): RegistryEntry {
    const resolvedBin = resolveBin(def.bin);
    return {
      id: def.id,
      name: def.name,
      kind: def.kind,
      bin: def.bin,
      resolvedBin,
      enabled: Boolean(resolvedBin) && def.enabled !== false,
      versionFlag: def.versionFlag,
      installCmd: def.installCmd,
      updateCmd: def.updateCmd
    };
  }

  /** Load and normalize <daemonDir>/<file> (array of partial defs), if present. */
  private async loadOverrides(file: string, kind: RegistryKind): Promise<RegistryDef[]> {
    try {
      const raw = await readFile(join(this.daemonDir, file), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .map((item) => normalizeDef(item, kind))
        .filter((def): def is RegistryDef => def !== null);
    } catch {
      return [];
    }
  }
}

const KINDS: RegistryKind[] = ["shell", "agent", "ide", "file-explorer", "browser"];

function normalizeDef(item: unknown, defaultKind: RegistryKind): RegistryDef | null {
  if (typeof item !== "object" || item === null) {
    return null;
  }
  const obj = item as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : undefined;
  const name = typeof obj.name === "string" ? obj.name : undefined;
  const bin =
    typeof obj.bin === "string"
      ? [obj.bin]
      : Array.isArray(obj.bin)
        ? obj.bin.filter((b): b is string => typeof b === "string")
        : [];

  if (!id || !name || bin.length === 0) {
    return null;
  }

  return {
    id,
    name,
    kind: KINDS.includes(obj.kind as RegistryKind) ? (obj.kind as RegistryKind) : defaultKind,
    bin,
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : undefined,
    versionFlag: typeof obj.versionFlag === "string" ? obj.versionFlag : undefined,
    installCmd: typeof obj.installCmd === "string" ? obj.installCmd : undefined,
    updateCmd: typeof obj.updateCmd === "string" ? obj.updateCmd : undefined
  };
}

/** Run a shell command to completion, capturing combined output (capped). */
function run(command: string): Promise<RegistryActionResult> {
  return new Promise((resolve) => {
    exec(command, { timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = `${stdout ?? ""}${stderr ?? ""}`.slice(0, 64_000);
      const exitCode = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
      resolve({ ok: !error, exitCode, output });
    });
  });
}
