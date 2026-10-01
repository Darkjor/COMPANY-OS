import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/core/db.ts";
import { loadDepartments } from "../src/core/departments.ts";
import { recordHook, sanitizeHook } from "../src/core/hooks.ts";
import { ingestAll } from "../src/core/ingest.ts";
import { overview, sessionDetail, type Ctx } from "../src/core/queries.ts";
import { createApp } from "../src/server/app.ts";

const NOW = Date.parse("2026-09-30T12:00:30Z");
const line = (o: object) => JSON.stringify(o) + "\n";
const SID = "s-1";
const vault = mkdtempSync(join(tmpdir(), "cos-hv-"));
const ctx: Ctx = { vaultDir: vault, vault: [], departments: loadDepartments("Z:/x"), hats: new Map() };

/** One transcript: prompt at :00, assistant tool_use at :05 (transcript alone says "working"). */
function transcriptRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cos-hooks-"));
  const proj = join(root, "c--Projects-demo");
  mkdirSync(proj, { recursive: true });
  const base = { sessionId: SID, cwd: "C:\\Projects\\demo" };
  writeFileSync(
    join(proj, `${SID}.jsonl`),
    line({ ...base, type: "user", uuid: "u1", timestamp: "2026-09-30T12:00:00Z", turnOrigin: "human", message: { content: "Hola" } }) +
      line({
        ...base, type: "assistant", uuid: "a1", timestamp: "2026-09-30T12:00:05Z",
        message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], usage: { input_tokens: 1, output_tokens: 1 } },
      }),
  );
  return root;
}

function hook(db: DB, event: string, ts: string, extra: Record<string, unknown> = {}, sid = SID): void {
  const rec = sanitizeHook(event, { session_id: sid, cwd: "C:\\Projects\\demo", ...extra });
  if (!rec) throw new Error("hook ignorado");
  recordHook(db, vault, rec, ts);
}

const session = (db: DB) => overview(db, ctx, 30, NOW).projects[0].sessions[0];
const mk = () => {
  const db = openDb(":memory:");
  ingestAll(db, transcriptRoot());
  return db;
};

describe("sanitizeHook (allow-list)", () => {
  it("keeps only allow-listed fields and drops prompts, commands, contents and replies", () => {
    const rec = sanitizeHook("PostToolUse", {
      session_id: "abc-1", cwd: "C:\\p", tool_name: "Bash", prompt: "SECRETO-prompt",
      tool_input: { command: "echo SECRETO-cmd", file_path: "C:\\p\\a.md", content: "SECRETO-contenido" },
      tool_response: { stdout: "SECRETO-salida" }, last_assistant_message: "SECRETO-respuesta",
      transcript_path: "C:\\x.jsonl", agent_id: "a1", agent_type: "copywriter",
    })!;
    expect(rec).toMatchObject({ sessionId: "abc-1", toolName: "Bash", filePath: "C:\\p\\a.md", agentId: "a1", agentType: "copywriter" });
    expect(JSON.stringify(rec)).not.toContain("SECRETO");
  });

  it("rejects bad event names, missing/odd session ids and non-object payloads", () => {
    expect(sanitizeHook("Stop; DROP", { session_id: "a" })).toBeNull();
    expect(sanitizeHook("Stop", { session_id: "../etc" })).toBeNull();
    expect(sanitizeHook("Stop", { cwd: "x" })).toBeNull();
    expect(sanitizeHook("Stop", "texto")).toBeNull();
    expect(sanitizeHook("Stop", null)).toBeNull();
  });

  it("TaskCreated/TaskCompleted keep key names (to study the payload), never values", () => {
    const rec = sanitizeHook("TaskCreated", { session_id: "a", task_subject: "SECRETO", team_name: "eq", teammate_name: "ana" })!;
    expect(rec.payloadKeys).toEqual(["session_id", "task_subject", "team_name", "teammate_name"]);
    expect(rec.teamName).toBe("eq");
    expect(JSON.stringify(rec)).not.toContain("SECRETO");
  });

  it("the hook_events table stores nothing outside the allow-list", () => {
    const db = openDb(":memory:");
    hook(db, "PreToolUse", "2026-09-30T12:00:01Z", { tool_name: "Bash", tool_input: { command: "SECRETO-cmd" }, prompt: "SECRETO-p" });
    expect(JSON.stringify(db.prepare("SELECT * FROM hook_events").all())).not.toContain("SECRETO");
  });
});

describe("state table (event → state)", () => {
  const cases: [string, Record<string, unknown>, string, string | null][] = [
    ["PreToolUse", { tool_name: "Bash" }, "working", null],
    ["PostToolUse", { tool_name: "Bash" }, "working", null],
    ["PostToolUseFailure", { tool_name: "Bash" }, "error", "failure"],
    ["StopFailure", {}, "error", "failure"],
    ["PermissionRequest", { tool_name: "Bash" }, "waiting", "permission"],
    ["Notification", { notification_type: "permission_prompt" }, "waiting", "permission"],
    ["Notification", { notification_type: "idle_prompt" }, "waiting", "question"],
    ["PreToolUse", { tool_name: "AskUserQuestion" }, "waiting", "question"],
    ["Stop", {}, "waiting", "finished"],
    ["SessionEnd", { reason: "other" }, "idle", "ended"],
  ];
  it.each(cases)("%s %j → %s (%s)", (event, extra, state, reason) => {
    const db = openDb(":memory:");
    hook(db, event, "2026-09-30T12:00:01Z", extra);
    expect(db.prepare("SELECT state, reason FROM hook_state").get()).toEqual({ state, reason });
  });

  it("an unrelated Notification does not change the state", () => {
    const db = openDb(":memory:");
    hook(db, "PreToolUse", "2026-09-30T12:00:01Z", { tool_name: "Bash" });
    hook(db, "Notification", "2026-09-30T12:00:02Z", { notification_type: "auth_success" });
    expect(db.prepare("SELECT state FROM hook_state").get()).toEqual({ state: "working" });
  });

  it("idle_prompt after Stop does not downgrade 'terminó' into 'te pregunta'", () => {
    const db = openDb(":memory:");
    hook(db, "Stop", "2026-09-30T12:00:01Z");
    hook(db, "Notification", "2026-09-30T12:01:01Z", { notification_type: "idle_prompt" });
    expect(db.prepare("SELECT reason FROM hook_state").get()).toEqual({ reason: "finished" });
  });

  it("subagent events are tracked per agent and do not touch the main agent", () => {
    const db = openDb(":memory:");
    hook(db, "Stop", "2026-09-30T12:00:01Z");
    hook(db, "PreToolUse", "2026-09-30T12:00:02Z", { tool_name: "Read", agent_id: "x9" });
    hook(db, "SubagentStop", "2026-09-30T12:00:03Z", { agent_id: "x9" });
    expect(db.prepare("SELECT agent_id, state FROM hook_state ORDER BY agent_id").all()).toEqual([
      { agent_id: "", state: "waiting" },
      { agent_id: "agent-x9", state: "done" },
    ]);
  });

  it("TaskCreated, TaskCompleted and TeammateIdle are only stored", () => {
    const db = openDb(":memory:");
    for (const e of ["TaskCreated", "TaskCompleted", "TeammateIdle"]) hook(db, e, "2026-09-30T12:00:01Z", { team_name: "eq", teammate_name: "ana" });
    expect(db.prepare("SELECT COUNT(*) n FROM hook_events").get()).toEqual({ n: 3 });
    expect(db.prepare("SELECT COUNT(*) n FROM hook_state").get()).toEqual({ n: 0 });
  });
});

describe("hooks vs transcript in the overview", () => {
  it("without hooks the transcript decides (as before)", () => {
    const s = session(mk());
    expect(s.status).toBe("working");
    expect(s.statusSource).toBe("transcript");
  });

  it("a fresh hook overrides the transcript: Stop → waiting 'terminó'", () => {
    const db = mk();
    hook(db, "Stop", "2026-09-30T12:00:10Z");
    const s = session(db);
    expect(s).toMatchObject({ status: "waiting", waitingKind: "finished", waitingLabel: "terminó", statusSource: "hooks" });
  });

  it("PermissionRequest → waiting 'pide permiso'; PostToolUseFailure → error", () => {
    const db = mk();
    hook(db, "PermissionRequest", "2026-09-30T12:00:10Z");
    expect(session(db)).toMatchObject({ status: "waiting", waitingKind: "permission", waitingLabel: "pide permiso" });
    hook(db, "PostToolUseFailure", "2026-09-30T12:00:20Z", { tool_name: "Bash" });
    expect(session(db)).toMatchObject({ status: "error", waitingKind: null });
  });

  it("a working hook that went stale (>10 min) falls back to the transcript", () => {
    const db = mk();
    hook(db, "PreToolUse", "2026-09-30T11:40:00Z", { tool_name: "Bash" });
    expect(session(db).statusSource).toBe("transcript");
  });

  it("if the transcript is much newer than the last hook, hooks were missed → transcript", () => {
    const db = mk();
    hook(db, "Stop", "2026-09-30T11:50:00Z"); // transcript has events at 12:00
    const s = session(db);
    expect(s.statusSource).toBe("transcript");
    expect(s.status).toBe("working");
  });

  it("SessionEnd → idle; headless sessions stay 'done' instead of 'waiting'", () => {
    const db = mk();
    hook(db, "SessionEnd", "2026-09-30T12:00:10Z");
    expect(session(db)).toMatchObject({ status: "idle", statusSource: "hooks" });
    db.exec("UPDATE sessions SET automated = 1");
    hook(db, "Stop", "2026-09-30T12:00:20Z");
    expect(session(db)).toMatchObject({ status: "done", waitingKind: null });
  });

  it("a subagent asking for permission calls the whole session", () => {
    const db = openDb(":memory:");
    const root = transcriptRoot();
    const sub = join(root, "c--Projects-demo", SID, "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "agent-x9.jsonl"), line({ sessionId: SID, cwd: "C:\\Projects\\demo", type: "assistant", uuid: "b1", timestamp: "2026-09-30T12:00:20Z", isSidechain: true, message: { id: "m2", model: "claude-sonnet-5-5", content: [{ type: "tool_use", id: "t2", name: "Write", input: { file_path: "a.md" } }], usage: { input_tokens: 1, output_tokens: 1 } } }));
    writeFileSync(join(sub, "agent-x9.meta.json"), JSON.stringify({ agentType: "copywriter", toolUseId: "spawn-1", spawnDepth: 1 }));
    ingestAll(db, root);
    hook(db, "PermissionRequest", "2026-09-30T12:00:25Z", { tool_name: "Write", agent_id: "x9" });
    expect(session(db)).toMatchObject({ status: "waiting", waitingKind: "permission" });
  });
});

describe("Stop → 'entregó' when the turn wrote a deliverable", () => {
  const file = join(vault, "Proyectos", "demo", "desarrollo", "2026-10-01-x", "informe.md");
  it("delivered vs finished, and the deliverable rides on the session", () => {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "# Informe de prueba\n\ntexto\n");
    const db = mk();
    hook(db, "UserPromptSubmit", "2026-09-30T12:00:01Z", { prompt: "SECRETO" });
    hook(db, "PostToolUse", "2026-09-30T12:00:08Z", { tool_name: "Write", tool_input: { file_path: file }, agent_id: "x9", agent_type: "dev-backend" });
    hook(db, "Stop", "2026-09-30T12:00:10Z");
    const s = session(db);
    expect(s).toMatchObject({ status: "waiting", waitingKind: "delivered", waitingLabel: "entregó" });
    expect(s.deliverable).toMatchObject({
      path: "Proyectos/demo/desarrollo/2026-10-01-x/informe.md", type: "informe", title: "Informe de prueba",
      at: "2026-09-30T12:00:08Z", hat: "dev-backend", review: null,
    });
    expect(sessionDetail(db, ctx, SID, 300, NOW)!.deliverables).toHaveLength(1);

    // A new turn without writes: the old deliverable no longer counts → "terminó".
    hook(db, "UserPromptSubmit", "2026-09-30T12:00:20Z");
    hook(db, "Stop", "2026-09-30T12:00:25Z");
    expect(session(db)).toMatchObject({ waitingKind: "finished", deliverable: null });
  });
});

describe("POST /hooks/:event", () => {
  const mkApp = (db: DB, rawHookLog?: { file: string; maxBytes: number }) =>
    createApp({ db, vaultDir: vault, ctx: () => ctx, hookToken: "tok", port: 4747, subscribe: () => () => {}, rawHookLog });
  const post = (app: ReturnType<typeof mkApp>, event: string, body: string, token = "tok") =>
    app.request(`http://127.0.0.1:4747/hooks/${event}?t=${token}`, { method: "POST", body, headers: { "content-type": "application/json" } });

  it("403 without the token; 200 {} on garbage; stores only allow-listed fields", async () => {
    const db = openDb(":memory:");
    const app = mkApp(db);
    expect((await post(app, "Stop", "{}", "mal")).status).toBe(403);
    const bad = await post(app, "Stop", "no es json");
    expect(bad.status).toBe(200);
    expect(await bad.json()).toEqual({});
    const ok = await post(app, "PreToolUse", JSON.stringify({ session_id: "s-9", tool_name: "Bash", tool_input: { command: "SECRETO" } }));
    expect(ok.status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) n FROM hook_events").get()).toEqual({ n: 1 });
    expect(JSON.stringify(db.prepare("SELECT * FROM hook_events").all())).not.toContain("SECRETO");
  });

  it("the raw ndjson is off by default and capped when enabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cos-raw-"));
    const file = join(dir, "raw.ndjson");
    const body = JSON.stringify({ session_id: "s-9", tool_name: "Bash" });
    await post(mkApp(openDb(":memory:")), "PreToolUse", body);
    expect(existsSync(file)).toBe(false);

    const app = mkApp(openDb(":memory:"), { file, maxBytes: 300 });
    for (let i = 0; i < 20; i++) await post(app, "PreToolUse", body);
    const lines = readFileSync(file, "utf8").trim().split("\n").length;
    expect(lines).toBeGreaterThan(0);
    expect(lines).toBeLessThan(20);
  });
});
