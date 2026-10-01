import { IDLE_AFTER_MS, WAITING_TTL_MS } from "./config.ts";
import type { DB } from "./db.ts";
import { classifySession, type Department } from "./departments.ts";
import { classifyDeliverable, hasUnseenDeliverableSince, latestDeliverable, listDeliverables, type Deliverable } from "./deliverables.ts";
import { freshHookState, hookStates, REASON_LABEL, turnStartOf, type HookReason } from "./hooks.ts";
import { buildTeam, type TeamConfig, type TeamView } from "./teams.ts";
import { listDepartmentFiles, resolveProject, type VaultEntry, type VaultProject } from "./vault.ts";

/** Everything read from the vault that queries need (reloaded by the server every few seconds). */
export interface Ctx {
  vaultDir: string;
  vault: VaultProject[];
  departments: Department[];
  /** HAT name → department slug (from the vault's HAT library). */
  hats: Map<string, string>;
  /** HAT name → tool-call cap from its `Tope de llamadas a herramientas: N` line (optional). */
  toolCaps?: Map<string, number>;
  /** Agent teams read from ~/.claude/teams (optional: tests and callers without teams omit it). */
  teams?: TeamConfig[];
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
  /** Why it waits (only when the state comes from hooks): permission | question | finished | delivered. */
  waitingKind: HookReason | null;
  /** Where `status` came from: official hooks, or inferred from the transcript. */
  source: "hooks" | "transcript";
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
  /** Set when the whole session runs as a HAT (`claude --agent <hat>`). */
  hat: { name: string; department: string } | null;
  crew: CrewMember[];
  /** Live subagents without a HAT (drawn as drones next to the main agent). */
  drones: number;
  /** With status "waiting": permission | question | finished | delivered. Null otherwise. */
  waitingKind: "permission" | "question" | "finished" | "delivered" | null;
  /** Spanish label for `waitingKind` ("pide permiso", "te pregunta", "terminó", "entregó"). */
  waitingLabel: string | null;
  /** Where `status` came from: official hooks or the transcript fallback. */
  statusSource: "hooks" | "transcript";
  /** Last deliverable the session wrote in its current turn; null if none. */
  deliverable: Deliverable | null;
  /** Set on the LEAD session of an agent team (teammates are linked by agent id, name or hook labels). */
  team: TeamView | null;
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
  request_shape: string | null;
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
export function deriveStatus(
  last: LastEvent | undefined,
  lastAt: string | null,
  now: number,
  finished: boolean,
  background = false,
): Status {
  if (finished) return "done";
  if (!last || !lastAt) return "idle";
  const age = now - Date.parse(lastAt);
  // A turn that ended (or was interrupted) is waiting on the human, for much longer than "working" stays fresh.
  const turnEnded = last.kind === "text" || (last.kind === "prompt" && last.summary.startsWith("[Request interrupted"));
  // A background subagent never waits on the human. Its final text is only "done" once it has been
  // quiet for a while (last resort: the hook or the task-notification normally says so first).
  if (background && turnEnded) return age > IDLE_AFTER_MS ? "done" : "working";
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
  const returned = db.prepare(
    "SELECT summary FROM events WHERE tool_use_id = ? AND kind IN ('tool_result','error') ORDER BY ts LIMIT 1",
  );
  // A background agent's own end: the parent transcript's <task-notification> (by agent id or spawn tool_use id).
  const notified = db.prepare(
    `SELECT MAX(ts) ts FROM task_notifications
     WHERE session_id = ? AND status IN ('completed','failed','killed') AND (tool_use_id = ? OR task_id = ?)`,
  );
  // "What is it doing" skips noise like bare tool results and thinking blocks.
  const action = db.prepare(
    "SELECT summary FROM events WHERE agent_id = ? AND kind IN ('tool_use','text','prompt','error') ORDER BY ts DESC, id DESC LIMIT 1",
  );
  const hooks = hookStates(db, sessionId);
  return rows.map((r) => {
    const last = lastEvent(db, r.id);
    const doing = action.get(r.id) as { summary: string } | undefined;
    const result = r.kind === "subagent" && r.spawn_tool_use_id
      ? (returned.get(r.spawn_tool_use_id) as { summary: string } | undefined)
      : undefined;
    // run_in_background: the spawn's tool_result ("Async agent launched…") arrives at once and says
    // nothing about the agent ending. It ends with SubagentStop / task-notification / long silence.
    const background = r.kind === "subagent" && (r.request_shape === "background" || !!result?.summary.startsWith("Async agent launched"));
    let finished = !background && !!result;
    if (background) {
      const taskId = r.id.slice(sessionId.length + 1).replace(/^agent-/, "");
      const n = notified.get(sessionId, r.spawn_tool_use_id ?? "-", taskId) as { ts: string | null } | undefined;
      // A later transcript event means the agent was resumed after that notification.
      finished = !!n?.ts && n.ts >= (r.last_event_at ?? "");
    }
    const parent = r.spawn_tool_use_id ? (owner.get(r.spawn_tool_use_id) as { agent_id: string } | undefined) : undefined;
    // Official hook signal first (main agent = key '', subagent = 'agent-<id>'); transcript when stale/missing.
    const hookRow = hooks.get(r.kind === "main" ? "" : r.id.slice(sessionId.length + 1));
    let hook = freshHookState(hookRow, r.last_event_at, now);
    // Ended session that delivered: "entregó" lasts until the human opens the deliverable (or 48 h, see freshHookState).
    if (hook?.state === "waiting" && hookRow?.event === "SessionEnd" && !hasUnseenDeliverableSince(db, sessionId, hookRow.turn_started_at)) {
      hook = { state: "idle", reason: null };
    }
    const fromHook = hook !== null && !(finished && r.kind === "subagent");
    return {
      id: r.id,
      kind: r.kind,
      agentType: r.agent_type,
      name: r.name,
      description: r.description,
      model: r.model,
      parentId: parent?.agent_id ?? (r.kind === "subagent" ? sessionId : null),
      spawnDepth: r.spawn_depth,
      status: fromHook && hook ? hook.state : deriveStatus(last, r.last_event_at, now, finished, background),
      current: doing?.summary ?? last?.summary ?? null,
      lastEventAt: r.last_event_at,
      tokens: tokens.get(r.id) ?? ZERO,
      hatDepartment: r.kind === "subagent" && r.agent_type ? hats.get(r.agent_type) ?? null : null,
      waitingKind: fromHook && hook?.state === "waiting" ? hook.reason : null,
      source: fromHook ? "hooks" : "transcript",
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
  agent_setting: string | null;
}

function toSessionView(db: DB, row: SessionRow, agents: AgentView[], ctx: Ctx, now = Date.now()): SessionView {
  const main = agents.find((a) => a.kind === "main");
  const subs = agents.filter((a) => a.kind === "subagent");
  const activeSubs = subs.filter((a) => a.status === "working").length;
  const hatDept = row.agent_setting ? ctx.hats.get(row.agent_setting) ?? null : null;
  let status: Status = main?.status ?? "idle";
  let kind: HookReason | null = main?.waitingKind ?? null;
  const source = main?.source ?? "transcript";
  const endedDelivered = hookStates(db, row.id).get("")?.event === "SessionEnd" && kind === "delivered";
  if (row.automated && status === "waiting" && !endedDelivered) {
    status = "done";
    kind = null;
    if (main) main.status = "done";
  }
  // A subagent blocked on the human (permission / question) calls the whole session for attention.
  const asking = subs.find((a) => a.status === "waiting" && (a.waitingKind === "permission" || a.waitingKind === "question"));
  if (asking && status !== "error" && status !== "done") {
    status = "waiting";
    kind = asking.waitingKind;
  } else if (activeSubs > 0 && status !== "error") status = "subagents";
  const teamCfg = ctx.teams?.find((t) => t.leadSessionId === row.id);
  const deliverable = latestDeliverable(db, ctx.vaultDir, row.id, turnStartOf(db, row.id, hookStates(db, row.id).get("")));
  if (status === "waiting" && kind === null) kind = deliverable ? "delivered" : "finished"; // transcript fallback
  if (status !== "waiting") kind = null;
  const waitingKind = kind === "permission" || kind === "question" || kind === "finished" || kind === "delivered" ? kind : null;
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
    department: hatDept ?? classifySession(row.cwd, row.title, ctx.vaultDir, ctx.departments),
    automated: row.automated === 1,
    hat: row.agent_setting && hatDept ? { name: row.agent_setting, department: hatDept } : null,
    crew: subs
      .filter((a) => a.hatDepartment && LIVE_STATUSES.has(a.status))
      .map((a) => ({
        id: a.id, hat: a.agentType ?? "hat", department: a.hatDepartment!, status: a.status, model: a.model, current: a.current,
      })),
    drones: subs.filter((a) => !a.hatDepartment && a.status === "working").length,
    waitingKind,
    waitingLabel: waitingKind ? REASON_LABEL[waitingKind] : null,
    statusSource: source,
    deliverable,
    team: teamCfg ? buildTeam(db, teamCfg, row.id, agents, ctx.hats, now) : null,
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
    const view = toSessionView(db, s, agents, ctx, now);
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

/** A deliverable as shown in the performance panel. */
export interface PerformanceDeliverable {
  path: string;
  type: Deliverable["type"];
  title: string;
  at: string;
}

/**
 * What an agent cost and delivered. Exact vs approximate (see docs/ARCHITECTURE.md):
 * - reportedTokens: EXACT, from Claude Code's task-notification (input + cache creation + real output; no cache reads). Null when the agent has no notification (main agent, foreground agents).
 * - newContext / cacheRead: from the JSONL, reliable.
 * - outputApprox: from the JSONL, UNDERCOUNTED (Claude Code logs the output_tokens of the start of the stream).
 */
export interface AgentPerformance {
  reportedTokens: number | null;
  newContext: number;
  cacheRead: number;
  outputApprox: number;
  toolCalls: number;
  toolCap: number | null;
  durationMs: number | null;
  deliverables: PerformanceDeliverable[];
}

const spanMs = (from: string | null, to: string | null): number | null => {
  const a = from ? Date.parse(from) : NaN;
  const b = to ? Date.parse(to) : NaN;
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.max(0, b - a);
};

const asPerf = (d: Deliverable): PerformanceDeliverable => ({ path: d.path, type: d.type, title: d.title, at: d.at });

/** Per-agent performance (by agent id) plus the session total (main agent included). */
function buildPerformance(db: DB, ctx: Ctx, row: SessionRow, agents: AgentView[]) {
  const rows = db
    .prepare("SELECT id, kind, agent_type, spawn_tool_use_id, started_at, last_event_at FROM agents WHERE session_id = ?")
    .all(row.id) as { id: string; kind: string; agent_type: string | null; spawn_tool_use_id: string | null; started_at: string | null; last_event_at: string | null }[];
  const calls = new Map(
    (db
      .prepare(
        `SELECT e.agent_id id, COUNT(*) n FROM events e JOIN agents a ON a.id = e.agent_id
         WHERE a.session_id = ? AND e.kind = 'tool_use' GROUP BY e.agent_id`,
      )
      .all(row.id) as { id: string; n: number }[]).map((r) => [r.id, r.n]),
  );
  const notes = db
    .prepare(
      `SELECT task_id, tool_use_id, subagent_tokens, tool_uses, duration_ms FROM task_notifications
       WHERE session_id = ? AND (subagent_tokens IS NOT NULL OR tool_uses IS NOT NULL OR duration_ms IS NOT NULL)
       ORDER BY ts, rowid`,
    )
    .all(row.id) as { task_id: string; tool_use_id: string; subagent_tokens: number | null; tool_uses: number | null; duration_ms: number | null }[];
  const touched = db
    .prepare(
      `SELECT f.agent_id id, f.path FROM files_touched f JOIN agents a ON a.id = f.agent_id
       WHERE a.session_id = ? AND f.op IN ('write','edit') ORDER BY f.ts`,
    )
    .all(row.id) as { id: string; path: string }[];
  const delivered = new Map(listDeliverables(db, ctx.vaultDir, { session: row.id, limit: 500 }).map((d) => [d.path, d]));

  const perAgent: Record<string, AgentPerformance> = {};
  for (const a of agents) {
    const r = rows.find((x) => x.id === a.id);
    const taskId = a.id.slice(row.id.length + 1).replace(/^agent-/, "");
    // Latest notification wins (a resumed agent notifies again).
    const n = a.kind === "subagent"
      ? notes.filter((x) => (r?.spawn_tool_use_id && x.tool_use_id === r.spawn_tool_use_id) || (taskId && x.task_id === taskId)).pop()
      : undefined;
    const paths = new Set<string>();
    const mine: PerformanceDeliverable[] = [];
    for (const t of touched) {
      if (t.id !== a.id) continue;
      const c = classifyDeliverable(ctx.vaultDir, t.path);
      const d = c ? delivered.get(c.path) : undefined;
      if (d && !paths.has(d.path)) {
        paths.add(d.path);
        mine.push(asPerf(d));
      }
    }
    const hat = a.kind === "main" ? row.agent_setting : r?.agent_type ?? null;
    perAgent[a.id] = {
      reportedTokens: n?.subagent_tokens ?? null,
      newContext: a.tokens.input + a.tokens.cacheCreate,
      cacheRead: a.tokens.cacheRead,
      outputApprox: a.tokens.output,
      toolCalls: n?.tool_uses ?? calls.get(a.id) ?? 0,
      toolCap: hat ? ctx.toolCaps?.get(hat) ?? null : null,
      durationMs: n?.duration_ms ?? spanMs(r?.started_at ?? null, r?.last_event_at ?? null),
      deliverables: mine,
    };
  }
  const all = Object.values(perAgent);
  const reported = all.filter((x) => x.reportedTokens !== null);
  const total: AgentPerformance = {
    reportedTokens: reported.length ? reported.reduce((n, x) => n + (x.reportedTokens ?? 0), 0) : null,
    newContext: all.reduce((n, x) => n + x.newContext, 0),
    cacheRead: all.reduce((n, x) => n + x.cacheRead, 0),
    outputApprox: all.reduce((n, x) => n + x.outputApprox, 0),
    toolCalls: all.reduce((n, x) => n + x.toolCalls, 0),
    toolCap: null,
    durationMs: spanMs(row.started_at, row.last_event_at),
    deliverables: [...delivered.values()].slice(0, 50).map(asPerf),
  };
  return { perAgent, total };
}

export function sessionDetail(db: DB, ctx: Ctx, sessionId: string, limit = 300, now = Date.now()) {
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
  if (!row) return null;
  const agents = buildAgents(db, sessionId, tokensByAgent(db), now, ctx.hats);
  const perf = buildPerformance(db, ctx, row, agents);
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
    session: toSessionView(db, row, agents, ctx, now),
    project: resolveProject(ctx.vault, row.cwd, row.project_dir),
    agents: agents.map((a) => ({ ...a, performance: perf.perAgent[a.id] })),
    performance: perf.total,
    events,
    files,
    deliverables: listDeliverables(db, ctx.vaultDir, { session: sessionId, limit: 50 }),
  };
}
