import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  project_dir   TEXT NOT NULL,
  cwd           TEXT,
  git_branch    TEXT,
  title         TEXT,
  model         TEXT,
  started_at    TEXT,
  last_event_at TEXT,
  automated     INTEGER NOT NULL DEFAULT 0,
  agent_setting TEXT
);

CREATE TABLE IF NOT EXISTS agents (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  kind             TEXT NOT NULL,          -- main | subagent
  agent_type       TEXT,
  name             TEXT,
  description      TEXT,
  spawn_depth      INTEGER NOT NULL DEFAULT 0,
  spawn_tool_use_id TEXT,
  model            TEXT,
  started_at       TEXT,
  last_event_at    TEXT,
  request_shape    TEXT                    -- meta.requestShape: "background" = run_in_background
);
CREATE INDEX IF NOT EXISTS idx_agents_session ON agents(session_id);

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  ts          TEXT NOT NULL,
  kind        TEXT NOT NULL,
  tool_name   TEXT,
  tool_use_id TEXT,
  summary     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_agent_ts ON events(agent_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_tool_use ON events(tool_use_id);

CREATE TABLE IF NOT EXISTS usage (
  message_id   TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  ts           TEXT NOT NULL,
  model        TEXT NOT NULL,
  input        INTEGER NOT NULL,
  output       INTEGER NOT NULL,
  cache_read   INTEGER NOT NULL,
  cache_create INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_agent ON usage(agent_id);

CREATE TABLE IF NOT EXISTS files_touched (
  agent_id TEXT NOT NULL,
  path     TEXT NOT NULL,
  op       TEXT NOT NULL,
  ts       TEXT NOT NULL,
  PRIMARY KEY (agent_id, path, op, ts)
);

CREATE TABLE IF NOT EXISTS ingest_state (
  file_path   TEXT PRIMARY KEY,
  byte_offset INTEGER NOT NULL,
  size        INTEGER NOT NULL
);

-- A background agent stopped (task-notification in the parent transcript). Rebuildable from transcripts.
CREATE TABLE IF NOT EXISTS task_notifications (
  session_id  TEXT NOT NULL,
  task_id     TEXT NOT NULL,           -- agent id ('' when the block carried none)
  tool_use_id TEXT NOT NULL,           -- the spawn's tool_use id ('' when none)
  status      TEXT NOT NULL,
  ts          TEXT NOT NULL,
  PRIMARY KEY (session_id, task_id, tool_use_id, status, ts)
);
CREATE INDEX IF NOT EXISTS idx_task_notifications_session ON task_notifications(session_id);

-- Hook log: ONLY allow-listed fields (see core/hooks.ts). Not rebuildable from transcripts.
CREATE TABLE IF NOT EXISTS hook_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  event             TEXT NOT NULL,
  cwd               TEXT,
  tool_name         TEXT,
  file_path         TEXT,
  notification_type TEXT,
  agent_id          TEXT,
  agent_type        TEXT,
  team_name         TEXT,
  teammate_name     TEXT,
  payload_keys      TEXT,
  task_id           TEXT             -- TaskCreated / TaskCompleted only (opaque id; subject and description are NOT kept)
);
CREATE INDEX IF NOT EXISTS idx_hook_events_session ON hook_events(session_id, ts);

-- Latest hook-derived state per (session, agent). agent_id '' = the main agent.
CREATE TABLE IF NOT EXISTS hook_state (
  session_id      TEXT NOT NULL,
  agent_id        TEXT NOT NULL DEFAULT '',
  state           TEXT NOT NULL,   -- working | error | waiting | idle | done
  reason          TEXT,            -- permission | question | finished | delivered | ended | failure | null
  event           TEXT NOT NULL,
  at              TEXT NOT NULL,
  turn_started_at TEXT,
  PRIMARY KEY (session_id, agent_id)
);

-- Vault files written by agents (Write/Edit under Proyectos/<slug>/<dept>/...).
CREATE TABLE IF NOT EXISTS deliverables (
  path       TEXT PRIMARY KEY,     -- relative to the vault, forward slashes
  session_id TEXT NOT NULL,
  project    TEXT NOT NULL,        -- slug
  department TEXT NOT NULL,
  type       TEXT NOT NULL,        -- para-direccion | informe | revision | plan | brief | otro
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source     TEXT NOT NULL,        -- hook | transcript
  agent_type TEXT,                 -- HAT/subagent type that wrote it, when known
  seen_at    TEXT                  -- when the human opened it (shared by monitor and phone)
);
CREATE INDEX IF NOT EXISTS idx_deliverables_session ON deliverables(session_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_deliverables_project ON deliverables(project, updated_at);
`;

export type DB = DatabaseSync;

const SCHEMA_VERSION = 7;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * Transcript tables are an index: a migration may simply force a full re-read of the transcripts
 * (v5 backfilled deliverables; v6 fills agents.request_shape and task_notifications; v7 refills task_notifications with the <usage> figures). hook_events / hook_state / deliverables are NOT rebuildable
 * from transcripts once Claude Code cleans them up, so migrations must never drop or reset them.
 */
function migrate(db: DB): void {
  // Additive columns are checked on every open: hook_events / deliverables are never rebuilt.
  addColumn(db, "sessions", "automated", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "sessions", "agent_setting", "TEXT");
  addColumn(db, "agents", "request_shape", "TEXT");
  addColumn(db, "hook_events", "task_id", "TEXT");
  addColumn(db, "deliverables", "seen_at", "TEXT");
  addColumn(db, "task_notifications", "subagent_tokens", "INTEGER");
  addColumn(db, "task_notifications", "tool_uses", "INTEGER");
  addColumn(db, "task_notifications", "duration_ms", "INTEGER");

  const { user_version: v } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (v >= SCHEMA_VERSION) return;
  db.exec("UPDATE sessions SET automated = 0"); // v2 misdetected interactive sessions; recompute
  db.exec("DELETE FROM task_notifications"); // rebuilt by the re-ingest below, now with <usage>
  db.exec("DELETE FROM ingest_state"); // re-ingest everything so old sessions get the new columns right
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

function addColumn(db: DB, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
