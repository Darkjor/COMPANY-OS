import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.ts";
import { loadDepartments } from "../src/core/departments.ts";
import { ingestAll } from "../src/core/ingest.ts";
import { overview } from "../src/core/queries.ts";

const NOW = Date.parse("2026-09-30T12:00:30Z");
const line = (o: object) => JSON.stringify(o) + "\n";

/** Fake ~/.claude/projects tree: a dev session that spawned a `copywriter` HAT subagent. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "cos-office-"));
  const proj = join(root, "c--Projects-demo");
  const sid = "s-1";
  mkdirSync(join(proj, sid, "subagents"), { recursive: true });
  const base = { sessionId: sid, cwd: "C:\\Projects\\demo", gitBranch: "main" };
  writeFileSync(
    join(proj, `${sid}.jsonl`),
    line({ ...base, type: "user", uuid: "u1", timestamp: "2026-09-30T12:00:00Z", message: { content: "Arregla el endpoint" } }) +
      line({
        ...base, type: "assistant", uuid: "a1", timestamp: "2026-09-30T12:00:05Z",
        message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "spawn-1", name: "Agent", input: { description: "copys" } }], usage: { input_tokens: 1, output_tokens: 2 } },
      }),
  );
  writeFileSync(
    join(proj, sid, "subagents", "agent-x1.jsonl"),
    line({
      ...base, type: "assistant", uuid: "b1", timestamp: "2026-09-30T12:00:20Z", isSidechain: true,
      message: { id: "m2", model: "claude-sonnet-5-5", content: [{ type: "tool_use", id: "t2", name: "Write", input: { file_path: "copys.md" } }], usage: { input_tokens: 1, output_tokens: 3 } },
    }),
  );
  writeFileSync(
    join(proj, sid, "subagents", "agent-x1.meta.json"),
    JSON.stringify({ agentType: "copywriter", name: "copys", description: "Copys del carrusel", toolUseId: "spawn-1", spawnDepth: 1 }),
  );
  return root;
}

describe("automated sessions", () => {
  it("a finished headless run is 'done', never 'waiting for you'", () => {
    const root = mkdtempSync(join(tmpdir(), "cos-auto-"));
    const proj = join(root, "c--Projects-demo");
    mkdirSync(proj, { recursive: true });
    const base = { sessionId: "auto-1", cwd: "C:\\Projects\\demo" };
    writeFileSync(
      join(proj, "auto-1.jsonl"),
      line({ ...base, type: "user", uuid: "u1", timestamp: "2026-09-30T12:00:00Z", promptSource: "sdk", turnOrigin: "sdk", message: { content: "Investiga X" } }) +
        line({ ...base, type: "assistant", uuid: "a1", timestamp: "2026-09-30T12:00:10Z", message: { id: "m1", model: "claude-haiku-4-5", content: [{ type: "text", text: "Listo, informe en el vault." }], usage: { input_tokens: 1, output_tokens: 1 } } }),
    );
    const db = openDb(":memory:");
    ingestAll(db, root);
    const ctx = { vaultDir: "Z:/v", vault: [], departments: loadDepartments("Z:/x"), hats: new Map<string, string>() };
    const s = overview(db, ctx, 30, NOW).projects[0].sessions[0];
    expect(s.automated).toBe(true);
    expect(s.status).toBe("done");
  });
});

describe("office seating", () => {
  it("seats a HAT subagent at its HAT's department, not its parent session's", () => {
    const db = openDb(":memory:");
    ingestAll(db, fixture());
    const ctx = {
      vaultDir: "Z:/vault",
      vault: [],
      departments: loadDepartments("Z:/no-existe"),
      hats: new Map([["copywriter", "marketing"]]),
    };
    const ov = overview(db, ctx, 30, NOW);
    const session = ov.projects[0].sessions[0];

    expect(session.department).toBe("desarrollo"); // "endpoint"-ish dev work, no title → fallback
    expect(session.crew).toEqual([
      expect.objectContaining({ hat: "copywriter", department: "marketing", status: "working", current: "Write copys.md" }),
    ]);
    expect(session.drones).toBe(0);

    const marketing = ov.projects[0].departments.find((d) => d.slug === "marketing")!;
    expect(marketing.status).toBe("working");
    expect(marketing.activeAgents).toBe(1);
  });
});

describe("interactive sessions", () => {
  it("VS Code prompts (promptSource sdk, turnOrigin human) are not automated", () => {
    const root = mkdtempSync(join(tmpdir(), "cos-human-"));
    const proj = join(root, "c--Projects-demo");
    mkdirSync(proj, { recursive: true });
    const base = { sessionId: "h-1", cwd: "C:\\Projects\\demo" };
    writeFileSync(
      join(proj, "h-1.jsonl"),
      line({ ...base, type: "user", uuid: "u1", timestamp: "2026-09-30T12:00:00Z", promptSource: "sdk", turnOrigin: "human", message: { content: "Hola" } }) +
        line({ ...base, type: "assistant", uuid: "a1", timestamp: "2026-09-30T12:00:10Z", message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "text", text: "¿Qué hacemos?" }], usage: { input_tokens: 1, output_tokens: 1 } } }),
    );
    const db = openDb(":memory:");
    ingestAll(db, root);
    const ctx = { vaultDir: "Z:/v", vault: [], departments: loadDepartments("Z:/x"), hats: new Map<string, string>() };
    const s = overview(db, ctx, 30, NOW).projects[0].sessions[0];
    expect(s.automated).toBe(false);
    expect(s.status).toBe("waiting");
  });
});

describe("sessions running as a HAT", () => {
  it("`claude --agent copywriter` sits in Marketing wearing its hat", () => {
    const root = mkdtempSync(join(tmpdir(), "cos-agent-"));
    const proj = join(root, "c--Projects-demo");
    mkdirSync(proj, { recursive: true });
    const base = { sessionId: "hat-1", cwd: "C:\Projects\demo" };
    writeFileSync(
      join(proj, "hat-1.jsonl"),
      line({ type: "agent-setting", agentSetting: "copywriter", sessionId: "hat-1" }) +
        line({ ...base, type: "user", uuid: "u1", timestamp: "2026-09-30T12:00:00Z", turnOrigin: "sdk", message: { content: "Copys del carrusel" } }) +
        line({ ...base, type: "assistant", uuid: "a1", timestamp: "2026-09-30T12:00:20Z", message: { id: "m1", model: "claude-sonnet-5-5", content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "copys.md" } }], usage: { input_tokens: 1, output_tokens: 1 } } }),
    );
    const db = openDb(":memory:");
    ingestAll(db, root);
    const ctx = { vaultDir: "Z:/v", vault: [], departments: loadDepartments("Z:/x"), hats: new Map([["copywriter", "marketing"]]) };
    const s = overview(db, ctx, 30, NOW).projects[0].sessions[0];
    expect(s.hat).toEqual({ name: "copywriter", department: "marketing" });
    expect(s.department).toBe("marketing");
  });
});
