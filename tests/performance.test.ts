import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.ts";
import { loadDepartments } from "../src/core/departments.ts";
import { parseToolCap } from "../src/core/hats.ts";
import { ingestAll } from "../src/core/ingest.ts";
import { extractNotifications } from "../src/core/parse.ts";
import { sessionDetail, type Ctx } from "../src/core/queries.ts";

const line = (o: object) => JSON.stringify(o) + "\n";
const SID = "s-perf";
const base = { sessionId: SID, cwd: "C:\Projects\demo" };

const NOTE =
  "<task-notification>\n<task-id>abc123</task-id>\n<tool-use-id>spawn-1</tool-use-id>\n<status>completed</status>\n" +
  "<summary>Agent finished</summary>\n<result>texto largo que no se guarda</result>\n" +
  "<usage><subagent_tokens>189341</subagent_tokens><tool_uses>50</tool_uses><duration_ms>638568</duration_ms></usage>\n</task-notification>";

function fixture(withNote: boolean) {
  const root = mkdtempSync(join(tmpdir(), "cos-perf-"));
  const vault = mkdtempSync(join(tmpdir(), "cos-perf-vault-"));
  const notas = join(vault, "Proyectos", "demo", "desarrollo", "2026-10-01-x", "notas.md");
  mkdirSync(join(vault, "Proyectos", "demo", "desarrollo", "2026-10-01-x"), { recursive: true });
  writeFileSync(notas, "# Notas de prueba\n");
  const proj = join(root, "c--Projects-demo");
  mkdirSync(join(proj, SID, "subagents"), { recursive: true });
  writeFileSync(
    join(proj, `${SID}.jsonl`),
    line({ ...base, type: "user", uuid: "u1", timestamp: "2026-10-01T17:00:00Z", message: { content: "Haz la parte 1d" } }) +
      line({
        ...base, type: "assistant", uuid: "a1", timestamp: "2026-10-01T17:00:05Z",
        message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "spawn-1", name: "Agent", input: { description: "1d", run_in_background: true } }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 } },
      }) +
      (withNote
        ? line({ ...base, type: "queue-operation", operation: "enqueue", timestamp: "2026-10-01T17:10:00Z", content: NOTE })
        : ""),
  );
  writeFileSync(
    join(proj, SID, "subagents", "agent-abc123.jsonl"),
    line({
      ...base, type: "assistant", uuid: "b1", timestamp: "2026-10-01T17:01:00Z", isSidechain: true,
      message: { id: "m2", model: "claude-sonnet-5-5", content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: notas, content: "x" } }], usage: { input_tokens: 3, output_tokens: 8, cache_read_input_tokens: 500, cache_creation_input_tokens: 4000 } },
    }) +
      line({
        ...base, type: "assistant", uuid: "b2", timestamp: "2026-10-01T17:03:00Z", isSidechain: true,
        message: { id: "m3", model: "claude-sonnet-5-5", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } }], usage: { input_tokens: 2, output_tokens: 8, cache_read_input_tokens: 700, cache_creation_input_tokens: 100 } },
      }),
  );
  writeFileSync(
    join(proj, SID, "subagents", "agent-abc123.meta.json"),
    JSON.stringify({ agentType: "dev-backend", description: "1d", toolUseId: "spawn-1", spawnDepth: 1, requestShape: "background" }),
  );
  const ctx: Ctx = { vaultDir: vault, vault: [], departments: loadDepartments("Z:/x"), hats: new Map([["dev-backend", "desarrollo"]]), toolCaps: new Map([["dev-backend", 60]]) };
  const db = openDb(":memory:");
  ingestAll(db, root, { vaultDir: vault });
  return { db, ctx };
}

describe("performance por agente", () => {
  it("lee el <usage> de la task-notification y no guarda el result", () => {
    const [n] = extractNotifications(NOTE);
    expect(n.status).toBe("completed");
    expect(n.usage).toEqual({ subagentTokens: 189341, toolUses: 50, durationMs: 638568 });
    expect(extractNotifications("<task-notification><task-id>a</task-id><status>completed</status></task-notification>")[0].usage).toBeNull();
  });

  it("usa lo reportado por Claude Code cuando hay notificación", () => {
    const { db, ctx } = fixture(true);
    const d = sessionDetail(db, ctx, SID)!;
    const sub = d.agents.find((a) => a.kind === "subagent")!;
    expect(sub.performance).toMatchObject({
      reportedTokens: 189341, toolCalls: 50, toolCap: 60, durationMs: 638568,
      newContext: 3 + 4000 + 2 + 100, cacheRead: 1200, outputApprox: 16,
    });
    expect(sub.performance.deliverables).toEqual([
      expect.objectContaining({ type: "otro", title: "Notas de prueba" }),
    ]);
    expect(sub.performance.deliverables[0].path).toBe("Proyectos/demo/desarrollo/2026-10-01-x/notas.md");
    const main = d.agents.find((a) => a.kind === "main")!;
    expect(main.performance).toMatchObject({ reportedTokens: null, toolCalls: 1, toolCap: null, cacheRead: 1000, newContext: 210 });
    expect(d.performance).toMatchObject({ reportedTokens: 189341, toolCalls: 51, toolCap: null, cacheRead: 2200 });
    expect(d.performance.durationMs).toBe(10 * 60_000);
    expect(d.performance.deliverables).toHaveLength(1);
  });

  it("sin notificación cae al conteo de tool_use y al rango de eventos", () => {
    const { db, ctx } = fixture(false);
    const sub = sessionDetail(db, ctx, SID)!.agents.find((a) => a.kind === "subagent")!;
    expect(sub.performance).toMatchObject({ reportedTokens: null, toolCalls: 2, toolCap: 60, durationMs: 2 * 60_000 });
  });

  it("lee el tope de llamadas del HAT", () => {
    expect(parseToolCap("- **Tope de llamadas a herramientas: 45** (salvo que el brief diga otro)")).toBe(45);
    expect(parseToolCap("sin tope")).toBeNull();
  });
});
