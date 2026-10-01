import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.ts";
import { loadDepartments } from "../src/core/departments.ts";
import { recordHook, sanitizeHook } from "../src/core/hooks.ts";
import { ingestAll } from "../src/core/ingest.ts";
import { extractNotifications } from "../src/core/parse.ts";
import { overview } from "../src/core/queries.ts";

const line = (o: object) => JSON.stringify(o) + "\n";
const SID = "s-bg";
const base = { sessionId: SID, cwd: "C:\\Projects\\demo" };
const ctx = { vaultDir: "Z:/v", vault: [], departments: loadDepartments("Z:/x"), hats: new Map([["dev-backend", "desarrollo"]]) };

const ASYNC_RESULT =
  "Async agent launched successfully. (internal metadata)\nagentId: abc123 (internal ID)\nThe agent is working in the background.";

interface Opts {
  background: boolean;
  /** ISO time of the subagent's last event. */
  lastAt: string;
  lastKind?: "tool" | "text";
  /** Extra lines appended to the parent transcript (e.g. a task-notification). */
  parentExtra?: string;
}

/** Parent session that spawned subagent "abc123"; the spawn's tool_result arrives right away. */
function fixture(o: Opts): string {
  const root = mkdtempSync(join(tmpdir(), "cos-bg-"));
  const proj = join(root, "c--Projects-demo");
  mkdirSync(join(proj, SID, "subagents"), { recursive: true });
  writeFileSync(
    join(proj, `${SID}.jsonl`),
    line({ ...base, type: "user", uuid: "u1", timestamp: "2026-10-01T17:00:00Z", message: { content: "Haz la parte 1b" } }) +
      line({
        ...base, type: "assistant", uuid: "a1", timestamp: "2026-10-01T17:00:05Z",
        message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "spawn-1", name: "Agent", input: { description: "1b", run_in_background: o.background } }], usage: { input_tokens: 1, output_tokens: 1 } },
      }) +
      line({
        ...base, type: "user", uuid: "u2", timestamp: "2026-10-01T17:00:06Z",
        message: { content: [{ type: "tool_result", tool_use_id: "spawn-1", content: [{ type: "text", text: o.background ? ASYNC_RESULT : "Listo" }] }] },
      }) +
      (o.parentExtra ?? ""),
  );
  const content =
    o.lastKind === "text"
      ? [{ type: "text", text: "Terminé: todo listo." }]
      : [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } }];
  writeFileSync(
    join(proj, SID, "subagents", "agent-abc123.jsonl"),
    line({ ...base, type: "assistant", uuid: "b1", timestamp: o.lastAt, isSidechain: true, message: { id: "m2", model: "claude-sonnet-5-5", content, usage: { input_tokens: 1, output_tokens: 1 } } }),
  );
  writeFileSync(
    join(proj, SID, "subagents", "agent-abc123.meta.json"),
    JSON.stringify({ agentType: "dev-backend", description: "1b", toolUseId: "spawn-1", spawnDepth: 1, ...(o.background ? { requestShape: "background" } : {}) }),
  );
  return root;
}

function session(root: string, now: number) {
  const db = openDb(":memory:");
  ingestAll(db, root);
  return { db, s: overview(db, ctx, 30, now).projects[0].sessions[0] };
}

const NOW = Date.parse("2026-10-01T17:00:40Z");

describe("background subagents", () => {
  it("the instant tool_result of a background spawn does not mean it finished", () => {
    const { s } = session(fixture({ background: true, lastAt: "2026-10-01T17:00:30Z" }), NOW);
    expect(s.status).toBe("subagents");
    expect(s.crew).toEqual([expect.objectContaining({ hat: "dev-backend", status: "working" })]);
  });

  it("a foreground subagent still finishes when its tool_result arrives", () => {
    const { s } = session(fixture({ background: false, lastAt: "2026-10-01T17:00:30Z" }), NOW);
    expect(s.crew).toEqual([]);
    expect(s.status).not.toBe("subagents");
  });

  it("finishes on the task-notification (completed) in the parent transcript", () => {
    const note = line({
      ...base, type: "user", uuid: "u3", timestamp: "2026-10-01T17:00:35Z",
      message: { content: "<task-notification>\n<task-id>abc123</task-id>\n<tool-use-id>spawn-1</tool-use-id>\n<output-file>C:\\x\\abc123.output</output-file>\n<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>" },
    });
    const { s } = session(fixture({ background: true, lastAt: "2026-10-01T17:00:30Z", parentExtra: note }), NOW);
    expect(s.crew).toEqual([]);
    expect(s.status).not.toBe("subagents");
  });

  it("a resumed agent (activity after its notification) is working again", () => {
    const note = line({
      ...base, type: "user", uuid: "u3", timestamp: "2026-10-01T17:00:20Z",
      message: { content: "<task-notification>\n<task-id>abc123</task-id>\n<tool-use-id>spawn-1</tool-use-id>\n<status>completed</status>\n</task-notification>" },
    });
    const { s } = session(fixture({ background: true, lastAt: "2026-10-01T17:00:30Z", parentExtra: note }), NOW);
    expect(s.status).toBe("subagents");
  });

  it("finishes on the SubagentStop hook", () => {
    const root = fixture({ background: true, lastAt: "2026-10-01T17:00:30Z" });
    const db = openDb(":memory:");
    ingestAll(db, root);
    const rec = sanitizeHook("SubagentStop", { session_id: SID, agent_id: "abc123", agent_type: "dev-backend" })!;
    recordHook(db, "Z:/v", rec, "2026-10-01T17:00:35Z");
    const s = overview(db, ctx, 30, NOW).projects[0].sessions[0];
    expect(s.crew).toEqual([]);
    expect(s.status).not.toBe("subagents");
  });

  it("last resort: final text and no activity for IDLE_AFTER_MS means done", () => {
    const later = Date.parse("2026-10-01T17:12:00Z");
    const { s } = session(fixture({ background: true, lastAt: "2026-10-01T17:00:30Z", lastKind: "text" }), later);
    expect(s.crew).toEqual([]);
  });

  it("fresh final text of a background agent is not 'waiting for you'", () => {
    const { s } = session(fixture({ background: true, lastAt: "2026-10-01T17:00:30Z", lastKind: "text" }), NOW);
    expect(s.status).toBe("subagents");
  });
});

describe("extractNotifications", () => {
  it("reads task-id, tool-use-id and status; ignores other text", () => {
    const t = "<task-notification>\n<task-id>aa1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n</task-notification>";
    expect(extractNotifications(t)).toEqual([{ taskId: "aa1", toolUseId: "toolu_1", status: "completed" }]);
    expect(extractNotifications("hola")).toEqual([]);
  });
});
