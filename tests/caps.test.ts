import { describe, expect, it } from "vitest";
import { capDecision, parsePromptCap } from "../src/core/caps.ts";
import { openDb } from "../src/core/db.ts";
import { recordHook, sanitizeHook } from "../src/core/hooks.ts";
import type { Ctx } from "../src/core/queries.ts";
import { createApp } from "../src/server/app.ts";

const S = "sess-1";
const caps = new Map([["dev-frontend", 10]]);

function setup(prompt?: string) {
  const db = openDb(":memory:");
  if (prompt) {
    db.prepare("INSERT INTO events(id, agent_id, ts, kind, summary) VALUES ('e1', ?, '2026-10-04T00:00:00Z', 'prompt', ?)").run(`${S}/agent-a1`, prompt);
  }
  const call = (tool = "Bash", agent: string | null = "a1", type = "dev-frontend") => {
    const rec = sanitizeHook("PreToolUse", { session_id: S, tool_name: tool, ...(agent ? { agent_id: agent, agent_type: type } : {}) })!;
    recordHook(db, "", rec, new Date().toISOString());
    return capDecision(db, rec, caps);
  };
  return { db, call };
}

describe("tope de llamadas hecho cumplir por hooks", () => {
  it("lee el tope del prompt", () => {
    expect(parsePromptCap("Tope: 35 llamadas. Tu brief…")).toBe(35);
    expect(parsePromptCap("tope 12 llamadas")).toBe(12);
    expect(parsePromptCap("sin tope")).toBeNull();
    expect(parsePromptCap(null)).toBeNull();
  });

  it("usa el tope del HAT: avisa a 5 del final y niega al pasarlo", () => {
    const { call } = setup();
    const out = Array.from({ length: 12 }, () => call());
    expect(out.slice(0, 5).every((d) => d === null)).toBe(true);
    expect(out[5]?.hookSpecificOutput.additionalContext).toContain("6 de 10");
    expect(out.slice(6, 10).every((d) => d === null)).toBe(true);
    expect(out[10]?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out[11]?.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("pasado el tope deja hasta 5 Write/Edit para guardar el entregable", () => {
    const { call } = setup();
    for (let i = 0; i < 10; i++) call();
    expect(call("Write")).toBeNull();
    expect(call("Edit")).toBeNull();
    expect(call("Bash")?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(call("Write")).toBeNull(); // 14
    expect(call("Write")).toBeNull(); // 15 = tope + 5
    expect(call("Write")?.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("entregar el informe (SubagentHandback) nunca se niega", () => {
    const { call } = setup();
    for (let i = 0; i < 20; i++) call();
    expect(call("SubagentHandback")).toBeNull();
    expect(call("SubagentHandback")).toBeNull();
  });

  it("el tope del prompt manda sobre el del HAT", () => {
    const { call } = setup("Tope: 3 llamadas. Haz X");
    call(); call(); call();
    expect(call()?.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("sesion principal y agentes sin tope: nunca se limitan", () => {
    const { call } = setup();
    for (let i = 0; i < 30; i++) {
      expect(call("Bash", null)).toBeNull();
      expect(call("Bash", "a2", "general-purpose")).toBeNull();
    }
  });

  it("la ruta /hooks/PreToolUse devuelve la decision", async () => {
    const db = openDb(":memory:");
    const ctx = { vaultDir: "", vault: [], departments: [], hats: new Map(), teams: [], toolCaps: new Map([["qa-tester", 1]]) } as unknown as Ctx;
    const app = createApp({ db, vaultDir: "", ctx: () => ctx, hookToken: "tok", port: 4747, subscribe: () => () => {} });
    const post = () =>
      app.request("http://127.0.0.1:4747/hooks/PreToolUse?t=tok", {
        method: "POST",
        headers: { host: "127.0.0.1:4747", "content-type": "application/json" },
        body: JSON.stringify({ session_id: S, tool_name: "Bash", agent_id: "q1", agent_type: "qa-tester" }),
      });
    expect(await (await post()).json()).toEqual({});
    const second = await (await post()).json();
    expect(second.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});
