import { describe, expect, it } from "vitest";
import { deriveStatus } from "../src/core/queries.ts";
import { parseLine, redact } from "../src/core/parse.ts";
import { guessName, resolveProject } from "../src/core/vault.ts";

const base = { sessionId: "s1", cwd: "C:\\Projects\\demo", timestamp: "2026-09-30T10:00:00.000Z", uuid: "u1" };

describe("parseLine", () => {
  it("ignores garbage and truncated lines", () => {
    expect(parseLine("")).toBeNull();
    expect(parseLine('{"type":"user",')).toBeNull();
  });

  it("extracts tool_use with file op and summary", () => {
    const line = JSON.stringify({
      ...base,
      type: "assistant",
      message: {
        id: "m1",
        model: "claude-sonnet-5",
        content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "src/a.ts" } }],
        usage: { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
      },
    });
    const p = parseLine(line)!;
    expect(p.events[0]).toMatchObject({ kind: "tool_use", toolName: "Edit", toolUseId: "t1", fileOp: "edit", filePath: "src/a.ts" });
    expect(p.events[0].summary).toBe("Edit src/a.ts");
    expect(p.usage).toMatchObject({ messageId: "m1", output: 7, cacheRead: 100, cacheCreate: 20 });
  });

  it("marks tool errors and keeps the tool_use_id link", () => {
    const line = JSON.stringify({
      ...base,
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "boom" }] },
    });
    expect(parseLine(line)!.events[0]).toMatchObject({ kind: "error", toolUseId: "t1", summary: "boom" });
  });

  it("skips synthetic model usage", () => {
    const line = JSON.stringify({ ...base, type: "assistant", message: { id: "m", model: "<synthetic>", content: [], usage: {} } });
    expect(parseLine(line)!.usage).toBeNull();
  });

  it("reads ai-title", () => {
    expect(parseLine(JSON.stringify({ type: "ai-title", sessionId: "s1", aiTitle: "Hola" }))!.title).toBe("Hola");
  });
});

describe("redact", () => {
  it("hides keys and tokens", () => {
    expect(redact("SUPABASE_ANON_KEY=abc123 ok")).toBe("SUPABASE_ANON_KEY=••• ok");
    expect(redact("token sk-ant-api03-abcdefghijklmnop")).toBe("token •••");
  });
});

describe("deriveStatus", () => {
  const now = Date.parse("2026-09-30T10:05:00Z");
  const recent = "2026-09-30T10:04:50Z";
  it("maps last event to status", () => {
    expect(deriveStatus({ kind: "tool_use", summary: "Bash" }, recent, now, false)).toBe("working");
    expect(deriveStatus({ kind: "text", summary: "listo" }, recent, now, false)).toBe("waiting");
    expect(deriveStatus({ kind: "error", summary: "x" }, recent, now, false)).toBe("error");
    expect(deriveStatus({ kind: "tool_use", summary: "Bash" }, "2026-09-30T09:00:00Z", now, false)).toBe("idle");
    expect(deriveStatus({ kind: "tool_use", summary: "Bash" }, recent, now, true)).toBe("done");
  });
  it("keeps a finished turn waiting for the human well past the idle window", () => {
    expect(deriveStatus({ kind: "text", summary: "listo" }, "2026-09-30T09:30:00Z", now, false)).toBe("waiting");
    expect(deriveStatus({ kind: "text", summary: "listo" }, "2026-09-30T07:00:00Z", now, false)).toBe("idle");
  });
});

describe("project mapping", () => {
  const vault = [
    { slug: "cumbre-real", name: "Cumbre Real", dir: "C:\\V\\Proyectos\\cumbre-real", repoPaths: ["C:\\Projects\\cumbre real en deploy"] },
  ];
  it("maps a session opened inside the vault project folder", () => {
    expect(resolveProject(vault, "C:\\V\\Proyectos\\cumbre-real\\marketing", "x").name).toBe("Cumbre Real");
  });
  it("maps nested cwd to vault project", () => {
    expect(resolveProject(vault, "C:\\Projects\\cumbre real en deploy\\app", "x")).toMatchObject({ name: "Cumbre Real", mapped: true });
  });
  it("does not match a sibling prefix", () => {
    expect(resolveProject(vault, "C:\\Projects\\cumbre real en deploy-2", "x").mapped).toBe(false);
  });
  it("guesses a name from the Projects folder", () => {
    expect(guessName("C:\\Users\\P\\Projects\\grupoveq\\src", "x")).toBe("grupoveq");
  });
});
