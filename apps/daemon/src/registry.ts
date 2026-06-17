import type {
  RegistryActionResult,
  RegistryEntry,
  RegistryKind,
  RegistryResponse
} from "@orquester/api";
import { exec } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

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

// Hardcoded defaults. Extend/override via <daemonDir>/{shells,agents}.json.
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

/** Resolve the first candidate that exists as an executable on PATH. */
function resolveBin(candidates: string[]): string | undefined {
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];

  for (const candidate of candidates) {
    // Already an absolute/explicit path.
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
 * Owns the catalog of launchable shells and agents. Resolves each entry's
 * binary against PATH once and caches it; an entry is `enabled` only when a
 * candidate bin was found (and it was not explicitly disabled).
 */
export class RegistryService {
  private entries = new Map<string, RegistryEntry>();

  constructor(private readonly daemonDir: string) {}

  async init(): Promise<void> {
    const shellDefs = [...DEFAULT_SHELLS, ...(await this.loadOverrides("shells.json", "shell"))];
    const agentDefs = [...DEFAULT_AGENTS, ...(await this.loadOverrides("agents.json", "agent"))];

    this.entries.clear();
    for (const def of [...shellDefs, ...agentDefs]) {
      this.entries.set(def.id, this.resolveDef(def));
    }
  }

  list(): RegistryResponse {
    const all = [...this.entries.values()];
    return {
      shells: all.filter((entry) => entry.kind === "shell"),
      agents: all.filter((entry) => entry.kind === "agent")
    };
  }

  get(id: string): RegistryEntry | undefined {
    return this.entries.get(id);
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
    await this.init(); // re-resolve so `enabled` reflects the new install
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

function normalizeDef(item: unknown, defaultKind: RegistryKind): RegistryDef | null {
  if (typeof item !== "object" || item === null) {
    return null;
  }
  const obj = item as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : undefined;
  const name = typeof obj.name === "string" ? obj.name : undefined;
  const bin = typeof obj.bin === "string" ? [obj.bin] : Array.isArray(obj.bin) ? obj.bin.filter((b): b is string => typeof b === "string") : [];

  if (!id || !name || bin.length === 0) {
    return null; // id, name and bin are required
  }

  return {
    id,
    name,
    kind: obj.kind === "shell" || obj.kind === "agent" ? obj.kind : defaultKind,
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
