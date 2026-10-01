import { IDLE_AFTER_MS, WAITING_TTL_MS } from "./config.ts";
import type { DB } from "./db.ts";
import { classifySession, type Department } from "./departments.ts";
import { listDepartmentFiles, resolveProject, type VaultEntry, type VaultProject } from "./vault.ts";

/** Everything read from the vault that queries need (reloaded by the server every few seconds). */
export interface Ctx {
  vaultDir: string;
  vault: VaultProject[];
  departments: Department[];
  /** HAT name → department slug (from the vault's HAT library). */
  hats: Map<string, string>;
}

export type Status = "working" | "waiting" | "subagents" | "error" | "idle" | "done";

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface AgentView {
  id: string;
  kind: "main" | "subagent";
  agentType: string | null;
  name: string | null;
  description: string | null;
  model: string | null;
  parentId: string | null;
  spawnDepth: number;
  status: Status;
  current: string | null;
  lastEventAt: string | null;
  tokens: Tokens;
  /** Department of the agent's HAT; null for the main agent and for subagents without a HAT. */
  hatDepartment: string | null;
}

/** A live subagent wearing a HAT: it sits at its own department's desk in the office. */
export interface CrewMember {
  id: string;
  hat: string;
  department: string;
  status: Status;
  model: string | null;
  current: string | null;
}

export interface SessionView {
  id: string;
  title: string | null;
  cwd: string | null;
  gitBranch: string | null;
  model: string | null;
  startedAt: string | null;
  lastEventAt: string | null;
  status: Status;
  current: string | null;
  tokens: Tokens;
  activeAgents: number;
  department: string;
  /** Launched headless (claude -p / SDK): a finished turn means "done", nobody is waiting for you. */
  automated: boolean;
  crew: CrewMember[];
  /** Live subagents without a HAT (drawn as drones next to the main agent). */
  drones: number;
}

export interface DeptSummary {
  slug: string;
  name: string;
  icon: string;
  status: Status;
  activeAgents: number;
  sessions: number;
}

export interface ProjectView {
  key: string;
  name: string;
  mapped: boolean;
  slug: string | null;
  status: Status;
  lastEventAt: string | null;
  tokensToday: Tokens;
  sessions: SessionView[];
  departments: DeptSummary[];
}

interface AgentRow {
  id: string;
  session_id: string;
  kind: "main" | "subagent";
  agent_type: string | null;
  name: string | null;
  description: string | null;
  model: string | null;
  spawn_depth: number;
  spawn_tool_use_id: string | null;
  last_event_at: string | null;
}

interface LastEvent {
  kind: string;
  summary: string;
}

const ZERO: Tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
const add = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheCreate: a.cacheCreate + b.cacheCreate,
});

const LIVE_STATUSES: ReadonlySet<Status> = new Set(["working", "subagents", "waiting", "error"]);

const STATUS_RANK: Record<Status, number> = { working: 5, subagents: 4, error: 3, waiting: 2, idle: 1, done: 0 };
export const hottest = (list: Status[]): Status =>
  list.reduce<Status>((a, b) => (STATUS_RANK[b] > STATUS_RANK[a] ? b : a), "idle");

/** Derive status from the last event only — the transcript is the single source of truth. */
export function deriveStatus(last: LastEvent | undefined, lastAt: string | null, now: number, finished: boolean): Status {
  if (finished) return "done";
  if (!last || !lastAt) return "idle";
  const age = now - Date.parse(lastAt);
  // A turn that ended (or was interrupted) is waiting on the human, for much longer than "working" stays fresh.
  const turnEnded = last.kind === "text" || (last.kind === "prompt" && last.summary.startsWith("[Request interrupted"));
  if (turnEnded) return age > WAITING_TTL_MS ? "idle" : "waiting";
  if (age > IDLE_AFTER_MS) return "idle";
  if (last.kind === "error") return "error";
  return "working";
}

function tokensByAgent(db: DB, since?: string): Map<string, Tokens> {
  const rows = db
    .prepare(
      `SELECT agent_id, SUM(input) i, SUM(output) o, SUM(cache_read) cr, SUM(cache_create) cc
       FROM usage ${since ? "WHERE ts >= ?" : ""} GROUP BY agent_id`,
    )
    .all(...(since ? [since] : [])) as { agent_id: string; i: number; o: number; cr: number; cc: number }[];
  return new Map(rows.map((r) => [r.agent_id, { input: r.i, output: r.o, cacheRead: r.cr, cacheCreate: r.cc }]));
}

function lastEvent(db: DB, agentId: string): LastEvent | undefined {
  return db
    .prepare("SELECT kind, summary FROM events WHERE agent_id = ? ORDER BY ts DESC, id DESC LIMIT 1")
    .get(agentId) as LastEvent | undefined;
}

function buildAgents(db: DB, sessionId: string, tokens: Map<string, Tokens>, now: number, hats: Map<string, string>): AgentView[] {
  const rows = db.prepare("SELECT * FROM agents WHERE session_id = ? ORDER BY started_at").all(sessionId) as unknown as AgentRow[];
  const owner = db.prepare("SELECT agent_id FROM events WHERE tool_use_id = ? AND kind = 'tool_use' LIMIT 1");
  const returned = db.prepare("SELECT 1 FROM events WHERE tool_use_id = ? AND kind IN ('tool_result','error') LIMIT 1");
  // "What is it doing" skips noise like bare tool results and thinking blocks.
  const action = db.prepare(
    "SELECT summary FROM events WHERE agent_id = ? AND kind IN ('tool_use','text','prompt','error') ORDER BY ts DESC, id DESC LIMIT 1",
  );
  return rows.map((r) => {
    const last = lastEvent(db, r.id);
    const doing = action.get(r.id) as { summary: string } | undefined;
    const finished = r.kind === "subagent" && !!r.spawn_tool_use_id && !!returned.get(r.spawn_tool_use_id);
    const parent = r.spawn_tool_use_id ? (owner.get(r.spawn_tool_use_id) as { agent_id: string } | undefined) : undefined;
    return {
      id: r.id,
      kind: r.kind,
      agentType: r.agent_type,
      name: r.name,
      description: r.description,
      model: r.model,
      parentId: parent?.agent_id ?? (r.kind === "subagent" ? sessionId : null),
      spawnDepth: r.spawn_depth,
      status: deriveStatus(last, r.last_event_at, now, finished),
      current: doing?.summary ?? last?.summary ?? null,
      lastEventAt: r.last_event_at,
      tokens: tokens.get(r.id) ?? ZERO,
      hatDepartment: r.kind === "subagent" && r.agent_type ? hats.get(r.agent_type) ?? null : null,
    };
  });
}

interface SessionRow {
  id: string;
  project_dir: string;
  cwd: string | null;
  git_branch: string | null;
  title: string | null;
  model: string | null;
  started_at: string | null;
  last_event_at: string | null;
  automated: number;
}

function toSessionView(row: SessionRow, agents: AgentView[], ctx: Ctx): SessionView {
  const main = agents.find((a) => a.kind === "main");
  const subs = agents.filter((a) => a.kind === "subagent");
  const activeSubs = subs.filter((a) => a.status === "working").length;
  let status: Status = main?.status ?? "idle";
  if (row.automated && status === "waiting") {
    status = "done";
    if (main) main.status = "done";
  }
  if (activeSubs > 0 && status !== "error") status = "subagents";
  return {
    id: row.id,
    title: row.title,
    cwd: row.cwd,
    gitBranch: row.git_branch,
    model: row.model ?? main?.model ?? null,
    startedAt: row.started_at,
    lastEventAt: row.last_event_at,
    status,
    current: main?.current ?? null,
    tokens: agents.reduce((t, a) => add(t, a.tokens), ZERO),
    activeAgents: agents.filter((a) => a.status === "working").length,
    department: classifySession(row.cwd, row.title, ctx.vaultDir, ctx.departments),
    automated: row.automated === 1,
    crew: subs
      .filter((a) => a.hatDepartment && LIVE_STATUSES.has(a.status))
      .map((a) => ({
        id: a.id, hat: a.agentType ?? "hat", department: a.hatDepartment!, status: a.status, model: a.model, current: a.current,
      })),
    drones: subs.filter((a) => !a.hatDepartment && a.status === "working").length,
  };
}

function summarizeDepartments(sessions: SessionView[], departments: Department[]): DeptSummary[] {
  return departments.map((d) => {
    const mine = sessions.filter((s) => s.department === d.slug);
    // HAT crew sits in its own department, whatever department its parent session belongs to.
    const crew = sessions.flatMap((s) => s.crew.filter((c) => c.department === d.slug));
    const statuses = [...mine.map((s) => s.status), ...crew.map((c) => c.status)];
    return {
      slug: d.slug,
      name: d.name,
      icon: d.icon,
      status: statuses.length ? hottest(statuses) : "idle",
      activeAgents:
        mine.reduce((n, s) => n + (s.status === "working" || s.status === "subagents" ? 1 : 0) + s.drones, 0) +
        crew.filter((c) => c.status === "working").length,
      sessions: mine.length,
    };
  });
}

function startOfToday(now: number): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function overview(db: DB, ctx: Ctx, days = 30, now = Date.now()) {
  const since = new Date(now - days * 86_400_000).toISOString();
  const sessions = db
    .prepare("SELECT * FROM sessions WHERE last_event_at >= ? ORDER BY last_event_at DESC")
    .all(since) as unknown as SessionRow[];
  const allTokens = tokensByAgent(db);
  const todayTokens = tokensByAgent(db, startOfToday(now));

  const projects = new Map<string, ProjectView>();
  let today = ZERO;
  for (const s of sessions) {
    const agents = buildAgents(db, s.id, allTokens, now, ctx.hats);
    const view = toSessionView(s, agents, ctx);
    const pk = resolveProject(ctx.vault, s.cwd, s.project_dir);
    let p = projects.get(pk.key);
    if (!p) {
      p = { ...pk, status: "idle", lastEventAt: null, tokensToday: ZERO, sessions: [], departments: [] };
      projects.set(pk.key, p);
    }
    p.sessions.push(view);
    if (!p.lastEventAt || (view.lastEventAt && view.lastEventAt > p.lastEventAt)) p.lastEventAt = view.lastEventAt;
    const sessToday = agents.reduce((t, a) => add(t, todayTokens.get(a.id) ?? ZERO), ZERO);
    p.tokensToday = add(p.tokensToday, sessToday);
    today = add(today, sessToday);
  }
  for (const p of projects.values()) {
    p.status = hottest(p.sessions.map((s) => s.status));
    p.departments = summarizeDepartments(p.sessions, ctx.departments);
  }
  // Vault projects with no recent sessions still exist in the company.
  for (const vp of ctx.vault) {
    const key = `vault:${vp.slug}`;
    if (projects.has(key)) continue;
    projects.set(key, {
      key, name: vp.name, mapped: true, slug: vp.slug, status: "idle", lastEventAt: null,
      tokensToday: ZERO, sessions: [], departments: summarizeDepartments([], ctx.departments),
    });
  }

  const list = [...projects.values()].sort((a, b) => (b.lastEventAt ?? "").localeCompare(a.lastEventAt ?? ""));
  return { generatedAt: new Date(now).toISOString(), tokensToday: today, projects: list };
}

export interface DepartmentDetail extends DeptSummary {
  sessionList: SessionView[];
  files: VaultEntry[];
}

/** One project as an office: every department with its sessions and its vault deliverables. */
export function projectDetail(db: DB, ctx: Ctx, key: string, now = Date.now()) {
  const project = overview(db, ctx, 3650, now).projects.find((p) => p.key === key);
  if (!project) return null;
  const vp = project.slug ? ctx.vault.find((v) => v.slug === project.slug) : undefined;
  const departments: DepartmentDetail[] = project.departments.map((d) => ({
    ...d,
    sessionList: project.sessions.filter((s) => s.department === d.slug),
    files: vp ? listDepartmentFiles(ctx.vaultDir, vp, d.slug) : [],
  }));
  return { project: { ...project, sessions: undefined }, departments, vaultDir: vp?.dir ?? null };
}

export function sessionDetail(db: DB, ctx: Ctx, sessionId: string, limit = 300, now = Date.now()) {
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
  if (!row) return null;
  const agents = buildAgents(db, sessionId, tokensByAgent(db), now, ctx.hats);
  const events = db
    .prepare(
      `SELECT e.id, e.agent_id agentId, e.ts, e.kind, e.tool_name toolName, e.summary
       FROM events e JOIN agents a ON a.id = e.agent_id
       WHERE a.session_id = ? ORDER BY e.ts DESC, e.id DESC LIMIT ?`,
    )
    .all(sessionId, limit);
  const files = db
    .prepare(
      `SELECT f.path, f.op, COUNT(*) n, MAX(f.ts) lastTs
       FROM files_touched f JOIN agents a ON a.id = f.agent_id
       WHERE a.session_id = ? GROUP BY f.path, f.op ORDER BY lastTs DESC LIMIT 100`,
    )
    .all(sessionId);
  return {
    session: toSessionView(row, agents, ctx),
    project: resolveProject(ctx.vault, row.cwd, row.project_dir),
    agents,
    events,
    files,
  };
}
