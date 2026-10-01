import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { log } from "./log.ts";

/**
 * A HAT is a role (copywriter, dev-backend, …) defined as Markdown with frontmatter.
 * Source of truth: `<vault>/_empresa/hats/*.md`. Installed as Claude Code subagents in
 * `~/.claude/agents/` so every project can use them.
 */
export interface Hat {
  name: string;
  description: string;
  model: string | null;
  tools: string | null;
  department: string | null;
  body: string;
  file: string;
}

/** Marker that identifies agent files written by Company OS (we never overwrite files without it). */
export const MANAGED_MARKER = "<!-- company-os:hat";

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseHat(text: string, file: string): Hat | null {
  const m = FM.exec(text);
  if (!m) return null;
  const fields = new Map<string, string>();
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (kv) fields.set(kv[1].toLowerCase(), kv[2].trim());
  }
  const name = fields.get("name") || basename(file, ".md");
  const description = fields.get("description");
  if (!/^[a-z0-9-]+$/.test(name) || !description) return null;
  return {
    name,
    description,
    model: fields.get("model") || null,
    tools: fields.get("tools") || null,
    department: fields.get("departamento") || fields.get("department") || null,
    body: m[2].trim(),
    file,
  };
}

export function loadHats(dir: string): Hat[] {
  if (!existsSync(dir)) return [];
  const out: Hat[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const file = join(dir, f);
    try {
      const hat = parseHat(readFileSync(file, "utf8"), file);
      if (hat) out.push(hat);
      else log.warn(`HAT inválido (falta name/description o frontmatter): ${file}`);
    } catch (err) {
      log.warn(`HAT ilegible ${file}: ${String(err)}`);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Claude Code subagent file: only the frontmatter keys Claude Code understands. */
export function toAgentFile(hat: Hat): string {
  const fm = [`name: ${hat.name}`, `description: ${hat.description}`];
  if (hat.model) fm.push(`model: ${hat.model}`);
  if (hat.tools) fm.push(`tools: ${hat.tools}`);
  return [
    "---",
    ...fm,
    "---",
    "",
    `${MANAGED_MARKER} departamento=${hat.department ?? "?"} — generado desde el vault de Company OS; edita el vault, no este archivo -->`,
    "",
    hat.body,
    "",
  ].join("\n");
}

export interface InstallResult {
  seeded: string[];
  installed: string[];
  skipped: string[];
}

/** 1) Seed the vault with default HATs it lacks. 2) Write every vault HAT into the agents dir. */
export function installHats(defaultsDir: string, vaultHatsDir: string, agentsDir: string): InstallResult {
  const result: InstallResult = { seeded: [], installed: [], skipped: [] };
  mkdirSync(vaultHatsDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });

  if (existsSync(defaultsDir)) {
    for (const f of readdirSync(defaultsDir)) {
      if (!f.endsWith(".md") || existsSync(join(vaultHatsDir, f))) continue;
      copyFileSync(join(defaultsDir, f), join(vaultHatsDir, f));
      result.seeded.push(basename(f, ".md"));
    }
  }

  for (const hat of loadHats(vaultHatsDir)) {
    const target = join(agentsDir, `${hat.name}.md`);
    if (existsSync(target) && !readFileSync(target, "utf8").includes(MANAGED_MARKER)) {
      result.skipped.push(hat.name); // a hand-written agent with the same name: never clobber it
      continue;
    }
    writeFileSync(target, toAgentFile(hat), "utf8");
    result.installed.push(hat.name);
  }
  return result;
}

/** HAT name → department slug, used to seat subagents at their department's desk. */
export function hatDepartments(vaultHatsDir: string): Map<string, string> {
  return new Map(loadHats(vaultHatsDir).flatMap((h) => (h.department ? [[h.name, h.department] as const] : [])));
}
