import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.ts";
import { backupDb, pruneBackups, pruneHookEvents, runMaintenance } from "../src/core/maintenance.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cos-maint-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = new Date(2026, 9, 15, 12, 0, 0); // 15-oct-2026 local
const addEvent = (db: ReturnType<typeof openDb>, ts: string, session = "s1") =>
  db.prepare("INSERT INTO hook_events (ts, session_id, event) VALUES (?, ?, 'PreToolUse')").run(ts, session);

describe("respaldo", () => {
  it("VACUUM INTO crea company-os-AAAA-MM-DD.db con los datos, y un segundo respaldo del dia lo reemplaza", () => {
    const db = openDb(join(dir, "main.db"));
    addEvent(db, NOW.toISOString());
    const file = backupDb(db, join(dir, "backups"), NOW);
    expect(file.endsWith("company-os-2026-10-15.db")).toBe(true);

    const copy = openDb(file);
    expect((copy.prepare("SELECT COUNT(*) AS n FROM hook_events").get() as { n: number }).n).toBe(1);
    copy.close();

    addEvent(db, NOW.toISOString(), "s2");
    backupDb(db, join(dir, "backups"), NOW); // mismo dia: no falla por "ya existe"
    const again = openDb(file);
    expect((again.prepare("SELECT COUNT(*) AS n FROM hook_events").get() as { n: number }).n).toBe(2);
    again.close();
    expect(readdirSync(join(dir, "backups")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    db.close();
  });

  it("conserva solo los 7 mas recientes y no toca archivos ajenos", () => {
    const db = openDb(":memory:");
    const bdir = join(dir, "backups");
    for (let d = 1; d <= 10; d++) backupDb(db, bdir, new Date(2026, 9, d, 9));
    writeFileSync(join(bdir, "notas.txt"), "mio");
    backupDb(db, bdir, new Date(2026, 9, 11, 9));
    const left = readdirSync(bdir).sort();
    expect(left.filter((n) => n.startsWith("company-os-"))).toEqual(
      [5, 6, 7, 8, 9, 10, 11].map((d) => `company-os-2026-10-${String(d).padStart(2, "0")}.db`),
    );
    expect(left).toContain("notas.txt");
    db.close();
  });

  it("pruneBackups sobre carpeta inexistente no falla", () => {
    expect(pruneBackups(join(dir, "nada"))).toEqual([]);
  });
});

describe("poda de hook_events", () => {
  it("borra lo anterior a 30 dias y deja el resto; no toca hook_state ni deliverables", () => {
    const db = openDb(":memory:");
    const day = 24 * 60 * 60 * 1000;
    addEvent(db, new Date(NOW.getTime() - 31 * day).toISOString(), "viejo");
    addEvent(db, new Date(NOW.getTime() - 29 * day).toISOString(), "reciente");
    addEvent(db, NOW.toISOString(), "hoy");
    db.prepare("INSERT INTO hook_state (session_id, agent_id, state, event, at) VALUES ('viejo', '', 'idle', 'SessionEnd', ?)").run(
      new Date(NOW.getTime() - 90 * day).toISOString(),
    );
    expect(pruneHookEvents(db, NOW)).toBe(1);
    const ids = (db.prepare("SELECT session_id FROM hook_events ORDER BY id").all() as { session_id: string }[]).map((r) => r.session_id);
    expect(ids).toEqual(["reciente", "hoy"]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM hook_state").get() as { n: number }).n).toBe(1);
    db.close();
  });

  it("runMaintenance respalda ANTES de podar (el respaldo conserva lo podado) y no lanza", () => {
    const db = openDb(join(dir, "main.db"));
    addEvent(db, new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString(), "viejo");
    runMaintenance(db, join(dir, "backups"), NOW);
    expect((db.prepare("SELECT COUNT(*) AS n FROM hook_events").get() as { n: number }).n).toBe(0);
    const copy = openDb(join(dir, "backups", "company-os-2026-10-15.db"));
    expect((copy.prepare("SELECT COUNT(*) AS n FROM hook_events").get() as { n: number }).n).toBe(1);
    copy.close();
    // carpeta de respaldo imposible (es un archivo): se registra y sigue, sin lanzar
    writeFileSync(join(dir, "bloqueo"), "x");
    expect(() => runMaintenance(db, join(dir, "bloqueo", "sub"), NOW)).not.toThrow();
    expect(existsSync(join(dir, "bloqueo", "sub"))).toBe(false);
    db.close();
  });
});
