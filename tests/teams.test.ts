import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.ts";
import { classifyDeliverable, listDeliverables, recordDeliverable } from "../src/core/deliverables.ts";
import { loadDepartments } from "../src/core/departments.ts";
import { recordHook, sanitizeHook } from "../src/core/hooks.ts";
import { ingestAll } from "../src/core/ingest.ts";
import { overview, sessionDetail, type Ctx } from "../src/core/queries.ts";
import { loadTeams, parseTeamConfig } from "../src/core/teams.ts";
import { createApp } from "../src/server/app.ts";

const line = (o: object) => JSON.stringify(o) + "\n";
const NOW = Date.parse("2026-10-01T17:00:40Z");
const SID = "lead-1";

const teamJson = {
  name: "rediseno",
  description: "Rediseño de la home",
  leadAgentId: "team-lead@rediseno",
  leadSessionId: SID,
  members: [
    { agentId: "team-lead@rediseno", name: "team-lead", agentType: "orchestrator", model: "claude-opus-5-5", prompt: "SECRETO-lead" },
    { agentId: "ana@rediseno", name: "ana", agentType: "copywriter", model: "claude-sonnet-5-5", prompt: "SECRETO-ana" },
    { agentId: "beto@rediseno", name: "beto", model: "claude-sonnet-5-5", isActive: false, prompt: "SECRETO-beto" },
    { agentId: "caro@rediseno", name: "caro", agentType: "disenador-ui", prompt: "SECRETO-caro" },
  ],
};

describe("team configs", () => {
  it("keeps only allow-listed fields: the spawn prompt never leaves the config", () => {
    const t = parseTeamConfig("rediseno", teamJson)!;
    expect(t.members).toHaveLength(4);
    expect(JSON.stringify(t)).not.toContain("SECRETO");
    expect(parseTeamConfig("x", { name: "x" })).toBeNull(); // no lead session
    expect(parseTeamConfig("x", { leadSessionId: "../../etc" })).toBeNull();
    expect(parseTeamConfig("x", "nope")).toBeNull();
  });

  it("loadTeams reads <dir>/<team>/config.json and skips broken ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "cos-teams-"));
    mkdirSync(join(dir, "rediseno"));
    writeFileSync(join(dir, "rediseno", "config.json"), JSON.stringify(teamJson));
    mkdirSync(join(dir, "roto"));
    writeFileSync(join(dir, "roto", "config.json"), "{no json");
    mkdirSync(join(dir, "vacio"));
    expect(loadTeams(dir).map((t) => t.id)).toEqual(["rediseno"]);
    expect(loadTeams(join(dir, "no-existe"))).toEqual([]);
  });
});

describe("team on the lead session", () => {
  /** Lead session that spawned subagent "x1" named "ana" (a copywriter); no files for beto/caro. */
  function build() {
    const root = mkdtempSync(join(tmpdir(), "cos-team-"));
    const proj = join(root, "c--Projects-demo");
    mkdirSync(join(proj, SID, "subagents"), { recursive: true });
    const base = { sessionId: SID, cwd: "C:\\Projects\\demo" };
    writeFileSync(
      join(proj, `${SID}.jsonl`),
      line({ ...base, type: "user", uuid: "u1", timestamp: "2026-10-01T17:00:00Z", message: { content: "Rediseña la home" } }),
    );
    writeFileSync(
      join(proj, SID, "subagents", "agent-x1.jsonl"),
      line({ ...base, type: "assistant", uuid: "b1", timestamp: "2026-10-01T17:00:30Z", isSidechain: true, message: { id: "m2", model: "claude-sonnet-5-5", content: [{ type: "tool_use", id: "t2", name: "Write", input: { file_path: "copys.md" } }], usage: { input_tokens: 1, output_tokens: 1 } } }),
    );
    writeFileSync(join(proj, SID, "subagents", "agent-x1.meta.json"), JSON.stringify({ agentType: "copywriter", name: "ana", toolUseId: "sp1", spawnDepth: 1 }));
    const db = openDb(":memory:");
    ingestAll(db, root);
    const ctx: Ctx = {
      vaultDir: "Z:/v", vault: [], departments: loadDepartments("Z:/x"),
      hats: new Map([["copywriter", "marketing"], ["disenador-ui", "diseno"]]),
      teams: [parseTeamConfig("rediseno", teamJson)!],
    };
    return { db, ctx };
  }

  it("exposes team = {id, name, leaderSessionId, members[]} with the spec's member shape", () => {
    const { db, ctx } = build();
    const s = overview(db, ctx, 30, NOW).projects[0].sessions[0];
    expect(s.team).toMatchObject({ id: "rediseno", name: "rediseno", leaderSessionId: SID });
    const by = Object.fromEntries(s.team!.members.map((m) => [m.name, m]));
    expect(Object.keys(by)).toEqual(["ana", "beto", "caro"]); // the lead is the session itself
    // ana: linked by the subagent's sidecar name
    expect(by.ana).toMatchObject({ hat: "copywriter", department: "marketing", status: "working", waitingKind: null, current: "Write copys.md" });
    // beto: config says finished; no HAT known
    expect(by.beto).toMatchObject({ hat: null, department: null, status: "done", model: "claude-sonnet-5-5" });
    // caro: nothing observed yet
    expect(by.caro).toMatchObject({ hat: "disenador-ui", department: "diseno", status: "idle", current: null });
    expect(JSON.stringify(s)).not.toContain("SECRETO");
    expect(sessionDetail(db, ctx, SID, 10, NOW)!.session.team?.members).toHaveLength(3);
  });

  it("links a teammate by the agent id a hook attributed to it, and by its own session", () => {
    const { db, ctx } = build();
    // beto: the hook says subagent x1 is beto (team + teammate labels with the agent id)
    recordHook(db, "Z:/v", sanitizeHook("TeammateIdle", { session_id: SID, agent_id: "x1", team_name: "rediseno", teammate_name: "beto" })!, "2026-10-01T17:00:31Z");
    // caro runs as its own session and reports with the team labels
    recordHook(db, "Z:/v", sanitizeHook("TaskCreated", { session_id: "caro-own", team_name: "rediseno", teammate_name: "caro", task_id: "7" })!, "2026-10-01T17:00:32Z");
    recordHook(db, "Z:/v", sanitizeHook("PreToolUse", { session_id: "caro-own", tool_name: "Read" })!, "2026-10-01T17:00:33Z");
    const by = Object.fromEntries(overview(db, ctx, 30, NOW).projects[0].sessions.find((x) => x.id === SID)!.team!.members.map((m) => [m.name, m]));
    expect(by.beto).toMatchObject({ status: "working", current: "Write copys.md" });
    expect(by.caro).toMatchObject({ status: "working", sessionId: "caro-own" });
  });

  it("sessions without a team config have team: null", () => {
    const { db, ctx } = build();
    const s = overview(db, { ...ctx, teams: [] }, 30, NOW).projects[0].sessions[0];
    expect(s.team).toBeNull();
  });
});

describe("TaskCreated / TaskCompleted", () => {
  it("store only the opaque task id; subject and description are dropped", () => {
    const db = openDb(":memory:");
    for (const ev of ["TaskCreated", "TaskCompleted"]) {
      const rec = sanitizeHook(ev, { session_id: "s", task_id: "42", task_subject: "SECRETO-asunto", task_description: "SECRETO-desc", team_name: "eq", teammate_name: "ana" })!;
      recordHook(db, "Z:/v", rec, "2026-10-01T10:00:00Z");
    }
    const rows = db.prepare("SELECT event, task_id, team_name, teammate_name FROM hook_events ORDER BY id").all();
    expect(rows).toEqual([
      { event: "TaskCreated", task_id: "42", team_name: "eq", teammate_name: "ana" },
      { event: "TaskCompleted", task_id: "42", team_name: "eq", teammate_name: "ana" },
    ]);
    expect(JSON.stringify(db.prepare("SELECT * FROM hook_events").all())).not.toContain("SECRETO");
    expect(sanitizeHook("PreToolUse", { session_id: "s", task_id: "42" })!.taskId).toBeNull();
  });
});

describe("shared 'seen' mark", () => {
  const vault = mkdtempSync(join(tmpdir(), "cos-seen-"));
  const file = join(vault, "Proyectos", "demo", "desarrollo", "2026-10-01-x", "informe.md");
  const path = "Proyectos/demo/desarrollo/2026-10-01-x/informe.md";
  const ctx: Ctx = { vaultDir: vault, vault: [], departments: loadDepartments("Z:/x"), hats: new Map() };
  const setup = () => {
    const db = openDb(":memory:");
    recordDeliverable(db, classifyDeliverable(vault, file)!, "s-1", "2026-10-01T10:00:00Z", "hook");
    const notified: string[][] = [];
    const app = createApp({ db, vaultDir: vault, ctx: () => ctx, hookToken: "t", port: 4747, subscribe: () => () => {}, notify: (ids) => notified.push(ids) });
    const post = (body: unknown, type = "application/json") =>
      app.request("http://127.0.0.1:4747/api/deliverables/seen", { method: "POST", headers: { "content-type": type }, body: typeof body === "string" ? body : JSON.stringify(body) });
    return { db, post, notified };
  };

  it("starts unseen, POST sets seenAt, it shows in the list and notifies the session", async () => {
    const { db, post, notified } = setup();
    expect(listDeliverables(db, vault)[0].seenAt).toBeNull();
    const res = await post({ path });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; seenAt: string };
    expect(body.path).toBe(path);
    expect(Date.parse(body.seenAt)).toBeGreaterThan(0);
    expect(listDeliverables(db, vault)[0].seenAt).toBe(body.seenAt);
    expect(notified).toEqual([["s-1"]]);
  });

  it("accepts backslashes and survives a re-write of the file (seenAt is kept, `at` moves on)", async () => {
    const { db, post } = setup();
    const first = (await (await post({ path: path.replace(/\//g, "\\") })).json()) as { seenAt: string };
    recordDeliverable(db, classifyDeliverable(vault, file)!, "s-1", "2099-01-01T00:00:00Z", "hook");
    const d = listDeliverables(db, vault)[0];
    expect(d.seenAt).toBe(first.seenAt);
    expect(d.at > d.seenAt!).toBe(true); // edited after being seen: the UI can show it as new again
  });

  it("rejects bad input: 400 without path, 404 unknown, 415 not JSON", async () => {
    const { post } = setup();
    expect((await post({})).status).toBe(400);
    expect((await post({ path: 42 })).status).toBe(400);
    expect((await post("{no json")).status).toBe(400);
    expect((await post({ path: "Proyectos/otro/x/y.md" })).status).toBe(404);
    expect((await post({ path }, "text/plain")).status).toBe(415);
  });
});

describe("schema migration", () => {
  it("adds the new columns to a v5 database without touching hook data", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const file = join(mkdtempSync(join(tmpdir(), "cos-mig-")), "old.db");
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE hook_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, session_id TEXT NOT NULL, event TEXT NOT NULL,
      cwd TEXT, tool_name TEXT, file_path TEXT, notification_type TEXT, agent_id TEXT, agent_type TEXT, team_name TEXT, teammate_name TEXT, payload_keys TEXT);
      CREATE TABLE deliverables (path TEXT PRIMARY KEY, session_id TEXT NOT NULL, project TEXT NOT NULL, department TEXT NOT NULL, type TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, source TEXT NOT NULL, agent_type TEXT);
      CREATE TABLE agents (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, agent_type TEXT, name TEXT, description TEXT,
      spawn_depth INTEGER NOT NULL DEFAULT 0, spawn_tool_use_id TEXT, model TEXT, started_at TEXT, last_event_at TEXT);
      INSERT INTO hook_events(ts, session_id, event) VALUES('2026-10-01T10:00:00Z','s','Stop');
      PRAGMA user_version = 5;`);
    old.close();
    const db = openDb(file);
    expect(db.prepare("SELECT event FROM hook_events").all()).toEqual([{ event: "Stop" }]);
    for (const [t, c] of [["hook_events", "task_id"], ["deliverables", "seen_at"], ["agents", "request_shape"]]) {
      expect((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((x) => x.name === c)).toBe(true);
    }
    db.close();
  });
});
