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
  /** Dev HATs work like a senior dev (Bash allowed, no prompts); this turns Bash off for one run. */
  noBash?: boolean;
}

/**
 * Hard limits for autonomous dev HATs: what is irreversible or leaves this PC needs the human.
 * The agent is not interrupted by them: the command is denied and it reports it at the end.
 * (Verified 2026-10-01 with Claude Code 2.1.286: denied commands do not run.)
 */
export const DENIED_COMMANDS = [
  "Bash(git push *)",
  "Bash(git push)",
  "Bash(git reset --hard *)",
  "Bash(git clean *)",
  "Bash(rm -rf *)",
  "Bash(vercel *)",
  "Bash(npx vercel *)",
  "Bash(npm publish *)",
  "Bash(npm publish)",
  "Bash(supabase db push *)",
  "Bash(supabase db reset *)",
  "Bash(npx supabase db push *)",
  "Bash(npx supabase db reset *)",
];

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
  const bash = !hat.tools && !opts.noBash; // HATs without a tools limit are the dev roles
  if (bash) tools.push("Bash");
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
      ...(bash ? ["--disallowedTools", ...DENIED_COMMANDS] : []),
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
