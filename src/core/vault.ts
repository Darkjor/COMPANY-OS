import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { log } from "./log.ts";

export interface VaultProject {
  slug: string;
  name: string;
  /** Absolute path of `Proyectos/<slug>` inside the vault. */
  dir: string;
  repoPaths: string[];
}

export interface ProjectKey {
  key: string;
  name: string;
  mapped: boolean;
  slug: string | null;
}

export interface VaultEntry {
  /** Path relative to the vault root, forward slashes. */
  path: string;
  name: string;
  kind: "file" | "dir";
  mtime: string;
  size: number;
  children?: VaultEntry[];
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

function projectsFolder(vaultDir: string): string | null {
  if (!existsSync(vaultDir)) return null;
  const folder = readdirSync(vaultDir).find((n) => n.toLowerCase() === "proyectos");
  return folder ? join(vaultDir, folder) : null;
}

/** Read `Proyectos/<slug>/PROYECTO.md` files: `nombre:` and one or more `repo_path:` lines. */
export function loadVaultProjects(vaultDir: string): VaultProject[] {
  const dir = projectsFolder(vaultDir);
  if (!dir) return [];
  const out: VaultProject[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projDir = join(dir, entry.name);
    const file = join(projDir, "PROYECTO.md");
    if (!existsSync(file)) continue;
    try {
      const text = readFileSync(file, "utf8");
      const name = /^\s*nombre:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? entry.name;
      const repoPaths = [...text.matchAll(/^\s*repo_path:\s*(.+)$/gim)].map((m) => m[1].trim().replace(/^["']|["']$/g, ""));
      out.push({ slug: entry.name, name, dir: projDir, repoPaths });
    } catch (err) {
      log.warn(`PROYECTO.md ilegible en ${entry.name}: ${String(err)}`);
    }
  }
  return out;
}

/** Fallback name when a session's folder is not registered in the vault. */
export function guessName(cwd: string | null, projectDir: string): string {
  if (cwd) {
    const segs = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
    const i = segs.findIndex((s) => s.toLowerCase() === "projects");
    if (i >= 0 && i + 1 < segs.length) return segs[i + 1];
    return segs.at(-1) ?? cwd;
  }
  const m = /-Projects-(.+)$/i.exec(projectDir);
  return m ? m[1] : projectDir;
}

export function resolveProject(projects: VaultProject[], cwd: string | null, projectDir: string): ProjectKey {
  if (cwd) {
    const c = norm(cwd);
    let best: { p: VaultProject; len: number } | null = null;
    for (const p of projects) {
      for (const rp of [...p.repoPaths, p.dir]) {
        const r = norm(rp);
        if ((c === r || c.startsWith(r + "/")) && (!best || r.length > best.len)) best = { p, len: r.length };
      }
    }
    if (best) return { key: `vault:${best.p.slug}`, name: best.p.name, mapped: true, slug: best.p.slug };
  }
  const name = guessName(cwd, projectDir);
  return { key: `dir:${name.toLowerCase()}`, name, mapped: false, slug: null };
}

const HIDDEN = /^(\.|node_modules$)/;

/** Tree of a department folder (2 levels: deliveries and their files). Newest first. */
export function listDepartmentFiles(vaultDir: string, project: VaultProject, dept: string, depth = 2): VaultEntry[] {
  const root = join(project.dir, dept);
  if (!existsSync(root)) return [];
  const walk = (dir: string, level: number): VaultEntry[] => {
    const out: VaultEntry[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (HIDDEN.test(e.name)) continue;
      const full = join(dir, e.name);
      try {
        const st = statSync(full);
        const entry: VaultEntry = {
          path: relative(vaultDir, full).split(sep).join("/"),
          name: e.name,
          kind: e.isDirectory() ? "dir" : "file",
          mtime: st.mtime.toISOString(),
          size: st.size,
        };
        if (e.isDirectory() && level < depth) entry.children = walk(full, level + 1);
        out.push(entry);
      } catch (err) {
        log.warn(`no se pudo leer ${full}: ${String(err)}`);
      }
    }
    return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  };
  return walk(root, 1);
}

const TEXT_EXT = /\.(md|txt|json|csv|ya?ml)$/i;
const MAX_TEXT = 512 * 1024;

/** Safe read of a text file inside the vault (rejects path traversal and non-text files). */
export function readVaultText(vaultDir: string, relPath: string): { path: string; content: string } | null {
  if (!TEXT_EXT.test(relPath)) return null;
  const root = realpathSync(vaultDir);
  const target = resolve(root, relPath);
  if (!existsSync(target)) return null;
  const real = realpathSync(target);
  if (real !== root && !real.startsWith(root + sep)) return null;
  const st = statSync(real);
  if (!st.isFile() || st.size > MAX_TEXT) return null;
  return { path: relPath, content: readFileSync(real, "utf8") };
}
