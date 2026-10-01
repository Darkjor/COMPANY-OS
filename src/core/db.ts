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
  last_event_at TEXT
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
  last_event_at    TEXT
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
`;

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);
  return db;
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
