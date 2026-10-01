import { IDLE_AFTER_MS, WAITING_TTL_MS } from "./config.ts";
import type { DB } from "./db.ts";
import { classifyDeliverable, DELIVERABLE_TOOLS, hasDeliverableSince, recordDeliverable } from "./deliverables.ts";

/**
 * Claude Code hooks → Company OS state. Official signals (hooks) are the primary source of
 * "what is each agent doing"; transcripts are the fallback (see queries.ts).
 *
 * Privacy: a hook payload carries prompts, commands, file contents and replies. We keep ONLY the
 * allow-listed fields below (`HookRecord`). Everything else is dropped before touching the DB.
 */

export type HookState = "working" | "error" | "waiting" | "idle" | "done";
export type HookReason = "permission" | "question" | "finished" | "delivered" | "ended" | "failure";

/** Spanish labels shown next to the state ("pide permiso", "te pregunta", ...). */
export const REASON_LABEL: Record<HookReason, string> = {
  permission: "pide permiso",
  question: "te pregunta",
  finished: "terminó",
  delivered: "entregó",
  ended: "sesión cerrada",
  failure: "falló",
};

/** The only data we keep from a hook payload. */
export interface HookRecord {
  event: string;
  sessionId: string;
  cwd: string | null;
  toolName: string | null;
  /** `tool_input.file_path` only — never the rest of tool_input. */
  filePath: string | null;
  notificationType: string | null;
  agentId: string | null;
  agentType: string | null;
  teamName: string | null;
  teammateName: string | null;
  /** TaskCreated / TaskCompleted only: the opaque task id (never its subject or description). */
  taskId: string | null;
  /** Top-level key NAMES (no values) for events whose payload we are still studying. */
  payloadKeys: string[] | null;
}

const EVENT_RE = /^[A-Za-z]{1,40}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{1,100}$/;
const STUDY_EVENTS = new Set(["TaskCreated", "TaskCompleted", "TeammateIdle"]);
const TASK_EVENTS = new Set(["TaskCreated", "TaskCompleted"]);

const clipStr = (v: unknown, max = 500): string | null =>
  typeof v === "string" && v.length > 0 && !v.includes("\0") ? v.slice(0, max) : null;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Validate the hook at the boundary and reduce it to the allow-list. Null = ignore the event. */
export function sanitizeHook(event: string, payload: unknown): HookRecord | null {
  if (!EVENT_RE.test(event) || !isObj(payload)) return null;
  const sessionId = clipStr(payload.session_id, 100);
  if (!sessionId || !SESSION_RE.test(sessionId)) return null;
  const input = isObj(payload.tool_input) ? payload.tool_input : null;
  return {
    event,
    sessionId,
    cwd: clipStr(payload.cwd, 1000),
    toolName: clipStr(payload.tool_name, 100),
    filePath: input ? clipStr(input.file_path, 1000) : null,
    notificationType: clipStr(payload.notification_type, 100),
    agentId: clipStr(payload.agent_id, 100),
    agentType: clipStr(payload.agent_type, 100),
    teamName: clipStr(payload.team_name, 200),
    teammateName: clipStr(payload.teammate_name, 200),
    taskId: TASK_EVENTS.has(event) ? clipStr(payload.task_id, 100) : null,
    payloadKeys: STUDY_EVENTS.has(event) ? Object.keys(payload).slice(0, 40).map((k) => k.slice(0, 60)) : null,
  };
}

export interface PrevState {
  state: HookState;
  reason: HookReason | null;
  /** Event that produced the stored state (to ignore a repeated SessionEnd). */
  event?: string;
}

/** An ended session that delivered something stays "entregó" this long (or until the human opens it). */
export const ENDED_DELIVERED_TTL_MS = 48 * 3_600_000;

export interface Transition {
  state: HookState;
  reason: HookReason | null;
}

/**
 * Event → state table (see ARCHITECTURE §7). Null = the event does not change the state.
 * `delivered` tells whether the current turn wrote a deliverable (Stop → "entregó").
 */
export function transition(rec: HookRecord, prev: PrevState | null, delivered: boolean): Transition | null {
  switch (rec.event) {
    case "UserPromptSubmit":
    case "PostToolUse":
    case "SubagentStart":
      return { state: "working", reason: null };
    case "PreToolUse":
      // AskUserQuestion blocks until the human answers.
      return rec.toolName === "AskUserQuestion"
        ? { state: "waiting", reason: "question" }
        : { state: "working", reason: null };
    case "PostToolUseFailure":
    case "StopFailure":
      return { state: "error", reason: "failure" };
    case "PermissionRequest":
      return { state: "waiting", reason: "permission" };
    case "Notification":
      if (rec.notificationType === "permission_prompt") return { state: "waiting", reason: "permission" };
      if (rec.notificationType === "elicitation_dialog") return { state: "waiting", reason: "question" };
      if (rec.notificationType === "idle_prompt") {
        // A reminder that Claude is idle. After a finished turn (Stop) it must not downgrade
        // "terminó"/"entregó" into "te pregunta" a minute later; otherwise it means "asks input".
        if (prev?.state === "waiting" && (prev.reason === "finished" || prev.reason === "delivered")) return null;
        return { state: "waiting", reason: "question" };
      }
      return null;
    case "Stop":
      return { state: "waiting", reason: delivered ? "delivered" : "finished" };
    case "SubagentStop":
      return { state: "done", reason: null };
    case "SessionEnd":
      // Headless (`claude -p`): Stop and SessionEnd arrive milliseconds apart. A session that ends right
      // after writing a deliverable keeps "entregó" (until seen or ENDED_DELIVERED_TTL_MS); a repeated
      // SessionEnd must not renew that window.
      if (prev?.event === "SessionEnd") return null;
      if (delivered && !rec.agentId) return { state: "waiting", reason: "delivered" };
      return { state: "idle", reason: "ended" };
    case "SessionStart":
      return { state: "idle", reason: null };
    default:
      return null;
  }
}

/**
 * Persist one hook. Returns the session id (for SSE) or null when ignored. Never throws on odd
 * payloads: the caller must always answer 200 so Claude is never blocked.
 */
export function recordHook(db: DB, vaultDir: string, rec: HookRecord, ts: string): string {
  db.prepare(
    `INSERT INTO hook_events(ts, session_id, event, cwd, tool_name, file_path, notification_type,
                             agent_id, agent_type, team_name, teammate_name, payload_keys, task_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    ts, rec.sessionId, rec.event, rec.cwd, rec.toolName, rec.filePath, rec.notificationType,
    rec.agentId, rec.agentType, rec.teamName, rec.teammateName,
    rec.payloadKeys ? JSON.stringify(rec.payloadKeys) : null,
    rec.taskId,
  );

  // Deliverable: a successful Write/Edit of a vault file (PostToolUse only = it really happened).
  if (rec.event === "PostToolUse" && rec.toolName && DELIVERABLE_TOOLS.has(rec.toolName) && rec.filePath) {
    const c = classifyDeliverable(vaultDir, rec.filePath);
    if (c) recordDeliverable(db, c, rec.sessionId, ts, "hook", rec.agentType);
  }

  const agentKey = rec.agentId ? `agent-${rec.agentId}` : "";
  const prevRow = db
    .prepare("SELECT state, reason, event, turn_started_at FROM hook_state WHERE session_id = ? AND agent_id = ?")
    .get(rec.sessionId, agentKey) as
    | { state: HookState; reason: HookReason | null; event: string; turn_started_at: string | null }
    | undefined;

  // Turn boundary (main agent only): a prompt opens a turn. The first event we ever see for a
  // session also opens one, so "entregó" works when hooks were installed mid-turn.
  let turnStart = prevRow?.turn_started_at ?? ts;
  if (!rec.agentId && rec.event === "UserPromptSubmit") turnStart = ts;

  const delivered =
    (rec.event === "Stop" || rec.event === "SessionEnd") && !rec.agentId && hasDeliverableSince(db, rec.sessionId, turnStart);
  const t = transition(rec, prevRow ?? null, delivered);
  if (t) {
    db.prepare(
      `INSERT INTO hook_state(session_id, agent_id, state, reason, event, at, turn_started_at)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(session_id, agent_id) DO UPDATE SET
         state = excluded.state, reason = excluded.reason, event = excluded.event,
         at = excluded.at, turn_started_at = excluded.turn_started_at`,
    ).run(rec.sessionId, agentKey, t.state, t.reason, rec.event, ts, turnStart);
  }
  return rec.sessionId;
}

export interface HookStateRow {
  agent_id: string;
  state: HookState;
  reason: HookReason | null;
  event: string;
  at: string;
  turn_started_at: string | null;
}

/** Hook states of a session keyed by agent key ('' = main, 'agent-<id>' = subagent). */
export function hookStates(db: DB, sessionId: string): Map<string, HookStateRow> {
  const rows = db.prepare("SELECT * FROM hook_state WHERE session_id = ?").all(sessionId) as unknown as HookStateRow[];
  return new Map(rows.map((r) => [r.agent_id, r]));
}

/**
 * Is the hook state still trustworthy? `agentLastAt` is the last transcript event of that agent.
 * Returns the state to show, or null to fall back to the transcript-derived one:
 *  - transcript clearly newer than the last hook → hooks were missed (server down, not installed);
 *  - working/error with no hook for 10 min → stale (same threshold as the transcript logic);
 *  - waiting beyond the waiting TTL → idle, like the transcript logic.
 */
export function freshHookState(
  h: HookStateRow | undefined,
  agentLastAt: string | null,
  now: number,
): { state: HookState; reason: HookReason | null } | null {
  if (!h) return null;
  const age = now - Date.parse(h.at);
  if (!Number.isFinite(age)) return null;
  if (agentLastAt && Date.parse(agentLastAt) > Date.parse(h.at) + 120_000) return null;
  // Ended session that delivered: lives 48 h (the "still unseen" check is the caller's, it has the db).
  if (h.state === "waiting" && h.event === "SessionEnd") {
    return age > ENDED_DELIVERED_TTL_MS ? { state: "idle", reason: null } : { state: h.state, reason: h.reason };
  }
  if (h.state === "waiting") return age > WAITING_TTL_MS ? { state: "idle", reason: null } : { state: h.state, reason: h.reason };
  if (h.state === "working" || h.state === "error") return age > IDLE_AFTER_MS ? null : { state: h.state, reason: h.reason };
  return { state: h.state, reason: h.reason };
}

/** Start of the session's current turn: hook-tracked, else the last human prompt in the transcript. */
export function turnStartOf(db: DB, sessionId: string, mainHook: HookStateRow | undefined): string | null {
  if (mainHook?.turn_started_at) return mainHook.turn_started_at;
  const row = db
    .prepare(
      "SELECT ts FROM events WHERE agent_id = ? AND kind = 'prompt' AND summary NOT LIKE '[Request interrupted%' ORDER BY ts DESC LIMIT 1",
    )
    .get(sessionId) as { ts: string } | undefined;
  return row?.ts ?? null;
}
