import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { tx, type DB } from "./db.ts";
import { log } from "./log.ts";
import { parseLine, type ParsedLine } from "./parse.ts";

export interface TranscriptRef {
  file: string;
  projectDir: string;
  sessionId: string;
  agentId: string;
  kind: "main" | "subagent";
}

/** Classify a path under the Claude projects dir. Returns null for files we don't read. */
export function classify(root: string, file: string): TranscriptRef | null {
  if (!file.endsWith(".jsonl")) return null;
  const parts = relative(root, file).split(sep);
  if (parts.length === 2) {
    const sessionId = basename(parts[1], ".jsonl");
    return { file, projectDir: parts[0], sessionId, agentId: sessionId, kind: "main" };
  }
  if (parts.length === 4 && parts[2] === "subagents" && parts[3].startsWith("agent-")) {
    const sessionId = parts[1];
    return {
      file,
      projectDir: parts[0],
      sessionId,
      agentId: `${sessionId}/${basename(parts[3], ".jsonl")}`,
      kind: "subagent",
    };
  }
  return null;
}

export function listTranscripts(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const proj of readdirSync(root, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const projPath = join(root, proj.name);
    for (const entry of readdirSync(projPath, { withFileTypes: true })) {
      const p = join(projPath, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(p);
      else if (entry.isDirectory()) {
        const subDir = join(p, "subagents");
        if (!existsSync(subDir)) continue;
        for (const s of readdirSync(subDir)) if (s.endsWith(".jsonl")) out.push(join(subDir, s));
      }
    }
  }
  return out;
}

/** Read only the bytes appended since last ingest; keep a trailing partial line for later. */
interface Chunk {
  lines: string[];
  newOffset: number;
  size: number;
}

function readNewLines(db: DB, file: string): Chunk | null {
  const size = statSync(file).size;
  const state = db.prepare("SELECT byte_offset FROM ingest_state WHERE file_path = ?").get(file) as
    | { byte_offset: number }
    | undefined;
  let offset = state?.byte_offset ?? 0;
  if (size < offset) offset = 0; // file was rewritten — re-read; inserts are idempotent
  if (size === offset) return null;

  const buf = Buffer.alloc(size - offset);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, buf.length, offset);
  } finally {
    closeSync(fd);
  }
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl === -1) return null;
  const consumed = lastNl + 1;
  return { lines: buf.subarray(0, consumed).toString("utf8").split("\n"), newOffset: offset + consumed, size };
}

function saveOffset(db: DB, file: string, chunk: Chunk): void {
  db.prepare(
    "INSERT INTO ingest_state(file_path, byte_offset, size) VALUES(?,?,?) " +
      "ON CONFLICT(file_path) DO UPDATE SET byte_offset = excluded.byte_offset, size = excluded.size",
  ).run(file, chunk.newOffset, chunk.size);
}

function readMeta(file: string): Record<string, unknown> {
  const metaPath = file.replace(/\.jsonl$/, ".meta.json");
  if (!existsSync(metaPath)) return {};
  try {
    return JSON.parse(readFileSync(metaPath, "utf8"));
  } catch (err) {
    log.warn(`meta ilegible ${metaPath}: ${String(err)}`);
    return {};
  }
}

const minTs = (a: string | null, b: string | null) => (!a ? b : !b ? a : a < b ? a : b);
const maxTs = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

/** Ingest new lines of one transcript. Returns the session id if anything changed. */
export function ingestFile(db: DB, ref: TranscriptRef): string | null {
  let chunk: Chunk | null;
  try {
    chunk = readNewLines(db, ref.file);
  } catch (err) {
    log.warn(`no se pudo leer ${ref.file}: ${String(err)}`);
    return null;
  }
  if (!chunk) return null;
  const parsed = chunk.lines.map(parseLine).filter((p): p is ParsedLine => p !== null);
  if (parsed.length === 0) {
    saveOffset(db, ref.file, chunk);
    return null;
  }

  let cwd: string | null = null;
  let branch: string | null = null;
  let title: string | null = null;
  let model: string | null = null;
  let first: string | null = null;
  let last: string | null = null;
  let automated = 0;
  let agentSetting: string | null = null;
  for (const p of parsed) {
    if (ref.kind === "main") agentSetting = p.agentSetting ?? agentSetting;
    if (ref.kind === "main" && p.turnOrigin === "sdk") automated = 1;
    cwd = p.cwd ?? cwd;
    branch = p.gitBranch ?? branch;
    if (ref.kind === "main") title = p.title ?? title;
    model = p.model ?? model;
    first = minTs(first, p.ts);
    last = maxTs(last, p.ts);
  }

  tx(db, () => {
    db.prepare(
      `INSERT INTO sessions(id, project_dir, cwd, git_branch, title, model, started_at, last_event_at, automated, agent_setting)
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         automated = MAX(sessions.automated, excluded.automated),
         agent_setting = COALESCE(excluded.agent_setting, sessions.agent_setting),
         cwd = COALESCE(sessions.cwd, excluded.cwd),
         git_branch = COALESCE(excluded.git_branch, sessions.git_branch),
         title = COALESCE(excluded.title, sessions.title),
         model = CASE WHEN ? = 'main' THEN COALESCE(excluded.model, sessions.model) ELSE sessions.model END,
         started_at = CASE WHEN sessions.started_at IS NULL OR excluded.started_at < sessions.started_at
                           THEN excluded.started_at ELSE sessions.started_at END,
         last_event_at = CASE WHEN sessions.last_event_at IS NULL OR excluded.last_event_at > sessions.last_event_at
                              THEN excluded.last_event_at ELSE sessions.last_event_at END`,
    ).run(ref.sessionId, ref.projectDir, cwd, branch, title, ref.kind === "main" ? model : null, first, last, automated, agentSetting, ref.kind);

    const meta = ref.kind === "subagent" ? readMeta(ref.file) : {};
    db.prepare(
      `INSERT INTO agents(id, session_id, kind, agent_type, name, description, spawn_depth, spawn_tool_use_id,
                          model, started_at, last_event_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         agent_type = COALESCE(excluded.agent_type, agents.agent_type),
         name = COALESCE(excluded.name, agents.name),
         description = COALESCE(excluded.description, agents.description),
         model = COALESCE(excluded.model, agents.model),
         started_at = CASE WHEN agents.started_at IS NULL OR excluded.started_at < agents.started_at
                           THEN excluded.started_at ELSE agents.started_at END,
         last_event_at = CASE WHEN agents.last_event_at IS NULL OR excluded.last_event_at > agents.last_event_at
                              THEN excluded.last_event_at ELSE agents.last_event_at END`,
    ).run(
      ref.agentId,
      ref.sessionId,
      ref.kind,
      (meta.agentType as string) ?? (ref.kind === "main" ? "main" : null),
      (meta.name as string) ?? null,
      (meta.description as string) ?? null,
      typeof meta.spawnDepth === "number" ? meta.spawnDepth : 0,
      (meta.toolUseId as string) ?? null,
      model,
      first,
      last,
    );

    const insEvent = db.prepare(
      "INSERT OR IGNORE INTO events(id, agent_id, ts, kind, tool_name, tool_use_id, summary) VALUES(?,?,?,?,?,?,?)",
    );
    const insFile = db.prepare("INSERT OR IGNORE INTO files_touched(agent_id, path, op, ts) VALUES(?,?,?,?)");
    const upUsage = db.prepare(
      `INSERT INTO usage(message_id, agent_id, ts, model, input, output, cache_read, cache_create)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(message_id) DO UPDATE SET
         ts = excluded.ts, input = excluded.input, output = excluded.output,
         cache_read = excluded.cache_read, cache_create = excluded.cache_create`,
    );
    for (const p of parsed) {
      for (const e of p.events) {
        insEvent.run(e.id, ref.agentId, e.ts, e.kind, e.toolName, e.toolUseId, e.summary);
        if (e.filePath && e.fileOp) insFile.run(ref.agentId, e.filePath, e.fileOp, e.ts);
      }
      const u = p.usage;
      if (u) upUsage.run(u.messageId, ref.agentId, u.ts, u.model, u.input, u.output, u.cacheRead, u.cacheCreate);
    }
    saveOffset(db, ref.file, chunk);
  });
  return ref.sessionId;
}

export function ingestAll(db: DB, root: string): Set<string> {
  const changed = new Set<string>();
  for (const file of listTranscripts(root)) {
    const ref = classify(root, file);
    if (!ref) continue;
    const sid = ingestFile(db, ref);
    if (sid) changed.add(sid);
  }
  return changed;
}
