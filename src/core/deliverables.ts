import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { DB } from "./db.ts";
import { readVaultHead } from "./vault.ts";

/**
 * A deliverable = a text file an agent wrote into the vault under
 * `Proyectos/<slug>/<departamento>/...`. Recorded from the PostToolUse hook (precise: only
 * successful writes) and, as a fallback, from the transcripts' Write/Edit tool_use blocks.
 */

export type DeliverableType = "para-direccion" | "informe" | "revision" | "plan" | "brief" | "otro";

export interface Deliverable {
  /** Relative to the vault, forward slashes: feed it to `/api/vault/file?path=`. */
  path: string;
  type: DeliverableType;
  /** First H1 of the file; the delivery's folder name when there is none. */
  title: string;
  /** Last write (ISO). */
  at: string;
  /** HAT / subagent type that wrote it; null when unknown. */
  hat: string | null;
  /** "aprobado" for `para-direccion` (it only exists after the reviewer passed); else null — never guessed. */
  review: "aprobado" | null;
  name: string;
  project: string;
  department: string;
  sessionId: string;
  createdAt: string;
  source: "hook" | "transcript";
}

export const DELIVERABLE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit"]);

const TEXT_EXT = /\.(md|txt|json|csv|ya?ml)$/i;
const strip = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Type from the file name (convention: `para-direccion.md`, `informe.md`, `revision.md`, ...). */
export function deliverableType(fileName: string): DeliverableType {
  const n = strip(fileName).replace(/\.[a-z0-9]+$/, "");
  if (/para[-_ ]?direccion/.test(n)) return "para-direccion";
  if (/(^|[-_ ])(revision|review)([-_ ]|$)/.test(n)) return "revision";
  if (/(^|[-_ ])(informe|report)([-_ ]|$)/.test(n)) return "informe";
  if (/(^|[-_ ])plan([-_ ]|$)/.test(n)) return "plan";
  if (/(^|[-_ ])brief([-_ ]|$)/.test(n)) return "brief";
  return "otro";
}

const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

export interface ClassifiedPath {
  path: string;
  project: string;
  department: string;
  type: DeliverableType;
}

/**
 * Map an absolute file path to a vault deliverable, or null when it is not one (outside the vault,
 * not under Proyectos/<slug>/<dept>/, hidden, or not a text file). Pure string work: the file may
 * not exist (yet) and symlinks are NOT resolved here — reading goes through `readVaultText`.
 */
export function classifyDeliverable(vaultDir: string, filePath: string): ClassifiedPath | null {
  if (!filePath || filePath.includes("\0") || !isAbsolute(filePath)) return null;
  const root = resolve(vaultDir);
  const rel = relative(root, resolve(filePath));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const segs = rel.split(sep);
  if (fold(segs[0]) !== "proyectos" || segs.length < 4) return null;
  if (segs.some((s) => s.startsWith("."))) return null;
  const file = segs[segs.length - 1];
  if (!TEXT_EXT.test(file)) return null;
  return { path: segs.join("/"), project: segs[1], department: segs[2], type: deliverableType(file) };
}

/** Create or update a deliverable. An older write never overwrites a newer one (re-ingest safety). */
export function recordDeliverable(
  db: DB,
  c: ClassifiedPath,
  sessionId: string,
  ts: string,
  source: "hook" | "transcript",
  agentType: string | null = null,
): void {
  db.prepare(
    `INSERT INTO deliverables(path, session_id, project, department, type, created_at, updated_at, source, agent_type)
     VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(path) DO UPDATE SET
       agent_type = CASE WHEN excluded.updated_at >= deliverables.updated_at THEN COALESCE(excluded.agent_type, deliverables.agent_type) ELSE deliverables.agent_type END,
       created_at = MIN(deliverables.created_at, excluded.created_at),
       session_id = CASE WHEN excluded.updated_at >= deliverables.updated_at THEN excluded.session_id ELSE deliverables.session_id END,
       source     = CASE WHEN excluded.updated_at >= deliverables.updated_at THEN excluded.source ELSE deliverables.source END,
       updated_at = MAX(deliverables.updated_at, excluded.updated_at)`,
  ).run(c.path, sessionId, c.project, c.department, c.type, ts, ts, source, agentType);
}

interface Row {
  path: string;
  session_id: string;
  project: string;
  department: string;
  type: DeliverableType;
  created_at: string;
  updated_at: string;
  source: "hook" | "transcript";
  agent_type: string | null;
  session_hat: string | null;
}

const SELECT = `SELECT d.*, s.agent_setting session_hat FROM deliverables d LEFT JOIN sessions s ON s.id = d.session_id`;

function h1(text: string): string | null {
  const m = /^#[ 	]+(.+?)[ 	#]*$/m.exec(text);
  return m ? m[1].trim().slice(0, 200) || null : null;
}

function toView(r: Row, vaultDir: string): Deliverable {
  const head = readVaultHead(vaultDir, r.path);
  const parent = basename(dirname(r.path));
  return {
    path: r.path,
    type: r.type,
    title: (head ? h1(head) : null) ?? parent,
    at: r.updated_at,
    hat: r.agent_type ?? r.session_hat,
    review: r.type === "para-direccion" ? "aprobado" : null,
    name: basename(r.path),
    project: r.project,
    department: r.department,
    sessionId: r.session_id,
    createdAt: r.created_at,
    source: r.source,
  };
}

/** `project` accepts a slug or a project key (`vault:<slug>`). Newest first. */
export function listDeliverables(
  db: DB,
  vaultDir: string,
  f: { project?: string; session?: string; limit?: number } = {},
): Deliverable[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.project) {
    where.push("d.project = ?");
    args.push(f.project.replace(/^vault:/, ""));
  }
  if (f.session) {
    where.push("d.session_id = ?");
    args.push(f.session);
  }
  const limit = Math.min(Math.max(Math.trunc(f.limit ?? 100) || 100, 1), 500);
  const rows = db
    .prepare(`${SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY d.updated_at DESC, d.path LIMIT ?`)
    .all(...args, limit) as unknown as Row[];
  return rows.map((r) => toView(r, vaultDir));
}

/** Last deliverable the session wrote since `since` (the start of its current turn); any if null. */
export function latestDeliverable(db: DB, vaultDir: string, sessionId: string, since: string | null): Deliverable | null {
  const row = db
    .prepare(`${SELECT} WHERE d.session_id = ? AND d.updated_at >= ? ORDER BY d.updated_at DESC LIMIT 1`)
    .get(sessionId, since ?? "") as unknown as Row | undefined;
  return row ? toView(row, vaultDir) : null;
}

export function hasDeliverableSince(db: DB, sessionId: string, since: string | null): boolean {
  return !!db.prepare("SELECT 1 FROM deliverables WHERE session_id = ? AND updated_at >= ? LIMIT 1").get(sessionId, since ?? "");
}
