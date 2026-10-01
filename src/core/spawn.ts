import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Hat } from "./hats.ts";

/**
 * Rules for launching agent sessions (decided 2026-10-01 after the Sonnet-vs-Haiku experiment):
 * every session runs as a HAT, gets a written brief instead of exploring, uses the HAT's model
 * and tools, and never a model the HAT forbids.
 */
export interface SpawnOptions {
  model?: string;
  vaultDir: string;
  /** Dev HATs have no `tools` limit; headless Bash is only allowed when the human says so. */
  allowBash?: boolean;
}

export interface SpawnPlan {
  args: string[];
  model: string;
  warnings: string[];
}

export class SpawnRefused extends Error {}

const READ_ONLY_DEV_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit", "WebSearch", "WebFetch"];
const REQUIRED_BRIEF_SECTIONS = ["objetivo", "contexto", "entregable"];

const modelFamily = (m: string) => {
  const x = m.toLowerCase();
  return ["opus", "sonnet", "haiku", "fable"].find((f) => x.includes(f)) ?? x;
};

export function planSpawn(hat: Hat | undefined, brief: string, opts: SpawnOptions): SpawnPlan {
  if (!hat) throw new SpawnRefused("toda sesión debe correr con un HAT de la biblioteca");
  if (brief.trim().length < 80) throw new SpawnRefused("el brief está vacío o es demasiado corto");

  const model = opts.model ?? hat.model ?? "sonnet";
  if (hat.forbiddenModels.includes(modelFamily(model))) {
    throw new SpawnRefused(`el HAT ${hat.name} tiene prohibido el modelo ${modelFamily(model)}`);
  }

  const warnings: string[] = [];
  const lower = brief.toLowerCase();
  const missing = REQUIRED_BRIEF_SECTIONS.filter((s) => !lower.includes(s));
  if (missing.length) warnings.push(`al brief le faltan secciones: ${missing.join(", ")} (ver _empresa/plantillas/brief.md)`);

  let tools = hat.tools ? hat.tools.split(",").map((t) => t.trim()).filter(Boolean) : [...READ_ONLY_DEV_TOOLS];
  if (!hat.tools && opts.allowBash) tools.push("Bash");
  if (!hat.tools && !opts.allowBash) warnings.push("HAT sin límite de herramientas: corre SIN Bash (usa --permitir-bash para habilitarlo)");
  tools = [...new Set(tools)];

  return {
    model,
    warnings,
    args: [
      "-p", brief,
      "--agent", hat.name,
      "--model", model,
      "--add-dir", opts.vaultDir,
      "--allowedTools", tools.join(" "),
      "--permission-mode", "acceptEdits",
      "--output-format", "text",
    ],
  };
}

/** Claude Code CLI: $CLAUDE_BIN, else the newest binary bundled with the VS Code/Antigravity extension. */
export function findClaudeBinary(): string | null {
  if (process.env.CLAUDE_BIN && existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  const roots = [".antigravity-ide", ".antigravity", ".vscode", ".cursor"].map((d) => join(homedir(), d, "extensions"));
  const found: { version: number[]; path: string }[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      const m = /^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/.exec(dir);
      const bin = join(root, dir, "resources", "native-binary", process.platform === "win32" ? "claude.exe" : "claude");
      if (m && existsSync(bin)) found.push({ version: m.slice(1).map(Number), path: bin });
    }
  }
  found.sort((a, b) => b.version[0] - a.version[0] || b.version[1] - a.version[1] || b.version[2] - a.version[2]);
  return found[0]?.path ?? null;
}
