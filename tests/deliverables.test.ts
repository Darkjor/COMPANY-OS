import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.ts";
import { loadDepartments } from "../src/core/departments.ts";
import { classifyDeliverable, deliverableType, listDeliverables, recordDeliverable } from "../src/core/deliverables.ts";
import { recordHook, sanitizeHook } from "../src/core/hooks.ts";
import { ingestAll } from "../src/core/ingest.ts";
import { overview, type Ctx } from "../src/core/queries.ts";
import { createApp } from "../src/server/app.ts";

const vault = mkdtempSync(join(tmpdir(), "cos-vault-"));
const outside = mkdtempSync(join(tmpdir(), "cos-outside-"));
const dir = join(vault, "Proyectos", "demo", "desarrollo", "2026-10-01-algo");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "informe.md"), "# Título del informe\n\ncuerpo");
writeFileSync(join(dir, "notas.md"), "sin encabezado");
writeFileSync(join(dir, "para-direccion.md"), "# Para dirección\n");
writeFileSync(join(vault, "Proyectos", "demo", "PROYECTO.md"), "nombre: Demo\n");
writeFileSync(join(outside, "secreto.md"), "FUERA-DEL-VAULT");
mkdirSync(join(vault, ".obsidian"), { recursive: true });
writeFileSync(join(vault, ".obsidian", "app.json"), "{}");

const ctx: Ctx = { vaultDir: vault, vault: [], departments: loadDepartments("Z:/x"), hats: new Map() };
const abs = (...p: string[]) => join(vault, ...p);

describe("deliverableType", () => {
  it.each([
    ["para-direccion.md", "para-direccion"], ["informe.md", "informe"], ["informe-final.md", "informe"],
    ["revision.md", "revision"], ["revisión.md", "revision"], ["plan.md", "plan"], ["plan-bandeja.md", "plan"],
    ["brief.md", "brief"], ["copys.md", "otro"], ["planilla.md", "otro"],
  ])("%s → %s", (name, type) => expect(deliverableType(name)).toBe(type));
});

describe("classifyDeliverable", () => {
  it("maps Proyectos/<slug>/<dept>/... to project, department and type", () => {
    expect(classifyDeliverable(vault, join(dir, "informe.md"))).toEqual({
      path: "Proyectos/demo/desarrollo/2026-10-01-algo/informe.md", project: "demo", department: "desarrollo", type: "informe",
    });
  });
  it("is case-insensitive on the vault prefix on Windows and accepts forward slashes", () => {
    const fwd = join(dir, "plan.md").replace(/\\/g, "/");
    expect(classifyDeliverable(vault, fwd)?.type).toBe("plan");
  });
  it.each([
    ["outside the vault", () => join(outside, "secreto.md")],
    ["a path that climbs out with ..", () => abs("Proyectos", "demo", "desarrollo", "..", "..", "..", "..", "x", "informe.md")],
    ["a relative path", () => "Proyectos/demo/desarrollo/x/informe.md"],
    ["the project root file", () => abs("Proyectos", "demo", "PROYECTO.md")],
    ["a file directly under the project (no department)", () => abs("Proyectos", "demo", "informe.md")],
    ["_empresa files", () => abs("_empresa", "hats", "a", "b.md")],
    ["hidden folders", () => abs("Proyectos", "demo", "desarrollo", ".obsidian", "x.md")],
    ["non-text files", () => abs("Proyectos", "demo", "desarrollo", "x", "foto.png")],
  ])("ignores %s", (_n, f) => expect(classifyDeliverable(vault, f())).toBeNull());
});

describe("recording", () => {
  const put = (db: ReturnType<typeof openDb>, ts: string, sid: string, file = join(dir, "informe.md")) => {
    const rec = sanitizeHook("PostToolUse", { session_id: sid, tool_name: "Write", tool_input: { file_path: file }, agent_type: "copywriter" })!;
    recordHook(db, vault, rec, ts);
  };

  it("a PostToolUse Write/Edit creates and then updates the deliverable; older writes never win", () => {
    const db = openDb(":memory:");
    put(db, "2026-10-01T10:00:00Z", "s-a");
    put(db, "2026-10-01T11:00:00Z", "s-b");
    put(db, "2026-10-01T09:00:00Z", "s-a"); // out of order
    const list = listDeliverables(db, vault);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ sessionId: "s-b", at: "2026-10-01T11:00:00Z", createdAt: "2026-10-01T09:00:00Z", hat: "copywriter", source: "hook" });
  });

  it("only successful Write/Edit-family tools count (not Read, not PreToolUse)", () => {
    const db = openDb(":memory:");
    for (const [event, tool] of [["PostToolUse", "Read"], ["PreToolUse", "Write"], ["PostToolUse", "Bash"]]) {
      recordHook(db, vault, sanitizeHook(event, { session_id: "s", tool_name: tool, tool_input: { file_path: join(dir, "informe.md") } })!, "2026-10-01T10:00:00Z");
    }
    expect(listDeliverables(db, vault)).toHaveLength(0);
  });

  it("transcript fallback: a Write tool_use on a vault file creates the deliverable", () => {
    const root = mkdtempSync(join(tmpdir(), "cos-dl-"));
    const proj = join(root, "c--Projects-demo");
    mkdirSync(proj, { recursive: true });
    const base = { sessionId: "t-1", cwd: "C:\\Projects\\demo" };
    writeFileSync(
      join(proj, "t-1.jsonl"),
      JSON.stringify({ ...base, type: "user", uuid: "u1", timestamp: "2026-10-01T10:00:00Z", message: { content: "haz el informe" } }) + "\n" +
        JSON.stringify({ ...base, type: "assistant", uuid: "a1", timestamp: "2026-10-01T10:00:05Z", message: { id: "m1", model: "claude-sonnet-5-5", content: [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: join(dir, "notas.md") } }, { type: "tool_use", id: "w2", name: "Write", input: { file_path: join(outside, "secreto.md") } }], usage: { input_tokens: 1, output_tokens: 1 } } }) + "\n",
    );
    const db = openDb(":memory:");
    ingestAll(db, root, { vaultDir: vault });
    const list = listDeliverables(db, vault, { session: "t-1" });
    expect(list.map((d) => [d.path, d.source])).toEqual([["Proyectos/demo/desarrollo/2026-10-01-algo/notas.md", "transcript"]]);
    // Without a vault configured nothing is recorded.
    const db2 = openDb(":memory:");
    ingestAll(db2, root);
    expect(listDeliverables(db2, vault)).toHaveLength(0);
  });
});

describe("views", () => {
  it("title = first H1, else the delivery folder; review only for para-direccion", () => {
    const db = openDb(":memory:");
    for (const f of ["informe.md", "notas.md", "para-direccion.md"]) {
      const c = classifyDeliverable(vault, join(dir, f))!;
      recordDeliverable(db, c, "s-1", "2026-10-01T10:00:00Z", "hook");
    }
    const by = Object.fromEntries(listDeliverables(db, vault).map((d) => [d.name, d]));
    expect(by["informe.md"]).toMatchObject({ title: "Título del informe", review: null, hat: null });
    expect(by["notas.md"]).toMatchObject({ title: "2026-10-01-algo", type: "otro", review: null });
    expect(by["para-direccion.md"]).toMatchObject({ title: "Para dirección", review: "aprobado" });
  });
});

describe("GET /api/deliverables", () => {
  const db = openDb(":memory:");
  recordDeliverable(db, classifyDeliverable(vault, join(dir, "informe.md"))!, "s-1", "2026-10-01T10:00:00Z", "hook");
  recordDeliverable(db, classifyDeliverable(vault, join(dir, "plan.md"))!, "s-2", "2026-10-01T11:00:00Z", "hook");
  const app = createApp({ db, vaultDir: vault, ctx: () => ctx, hookToken: "t", subscribe: () => () => {} });
  const get = async (q: string) => ((await (await app.request(`/api/deliverables${q}`)).json()) as { deliverables: { path: string; sessionId: string }[] }).deliverables;

  it("lists newest first and filters by session and by project (slug or key)", async () => {
    expect((await get("")).map((d) => d.sessionId)).toEqual(["s-2", "s-1"]);
    expect((await get("?session=s-1")).map((d) => d.sessionId)).toEqual(["s-1"]);
    expect(await get("?project=demo")).toHaveLength(2);
    expect(await get("?project=vault:demo")).toHaveLength(2);
    expect(await get("?project=otro")).toHaveLength(0);
  });

  it("session overview carries the turn's deliverable", () => {
    const root = mkdtempSync(join(tmpdir(), "cos-ov-"));
    mkdirSync(join(root, "c--Projects-demo"), { recursive: true });
    writeFileSync(
      join(root, "c--Projects-demo", "s-1.jsonl"),
      JSON.stringify({ sessionId: "s-1", cwd: "C:\\Projects\\demo", type: "user", uuid: "u1", timestamp: "2026-10-01T09:59:00Z", turnOrigin: "human", message: { content: "hola" } }) + "\n",
    );
    ingestAll(db, root);
    const s = overview(db, ctx, 30, Date.parse("2026-10-01T10:00:30Z")).projects[0].sessions[0];
    expect(s.deliverable).toMatchObject({ path: "Proyectos/demo/desarrollo/2026-10-01-algo/informe.md", type: "informe", title: "Título del informe" });
  });
});

describe("GET /api/vault/file stays inside the vault", () => {
  const app = createApp({ db: openDb(":memory:"), vaultDir: vault, ctx: () => ctx, hookToken: "t", subscribe: () => () => {} });
  const get = (path: string) => app.request(`/api/vault/file?path=${encodeURIComponent(path)}`);

  it("reads a normal vault file", async () => {
    const r = await get("Proyectos/demo/desarrollo/2026-10-01-algo/informe.md");
    expect(r.status).toBe(200);
    expect((await r.json()) as { content: string }).toMatchObject({ content: expect.stringContaining("Título del informe") });
  });

  it.each([
    ["parent traversal", `../${"x"}/secreto.md`],
    ["deep traversal", "Proyectos/../../secreto.md"],
    ["backslash traversal", "Proyectos\\..\\..\\secreto.md"],
    ["absolute path", join(outside, "secreto.md")],
    ["absolute path with forward slashes", join(outside, "secreto.md").replace(/\\/g, "/")],
    ["UNC path", "\\\\localhost\\c$\\Windows\\win.ini"],
    ["drive-relative", "C:secreto.md"],
    ["alternate data stream", "Proyectos/demo/PROYECTO.md:stream"],
    ["hidden folder", ".obsidian/app.json"],
    ["NUL byte", "Proyectos/demo/PROYECTO.md\0.png"],
    ["leading slash", "/Proyectos/demo/PROYECTO.md"],
    ["non-text extension", "Proyectos/demo/desarrollo/x/foto.png"],
  ])("rejects %s", async (_n, path) => {
    const r = await get(path);
    expect(r.status).toBe(404);
    expect(JSON.stringify(await r.json())).not.toContain("FUERA-DEL-VAULT");
  });

  it("rejects a symlink/junction that points outside the vault", async () => {
    let linked = false;
    try {
      symlinkSync(outside, join(vault, "Proyectos", "enlace"), "junction");
      linked = true;
    } catch {
      /* no permission to create links on this machine: the rest of the cases still run */
    }
    try {
      symlinkSync(join(outside, "secreto.md"), join(vault, "Proyectos", "demo", "atajo.md"), "file");
      linked = true;
    } catch {
      /* idem */
    }
    if (!linked) return;
    expect((await get("Proyectos/enlace/secreto.md")).status).toBe(404);
    expect((await get("Proyectos/demo/atajo.md")).status).toBe(404);
  });
});
