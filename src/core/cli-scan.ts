import { CLAUDE_PROJECTS_DIR, DB_PATH, VAULT_DIR } from "./config.ts";
import { openDb } from "./db.ts";
import { loadDepartments } from "./departments.ts";
import { ingestAll } from "./ingest.ts";
import { log } from "./log.ts";
import { overview } from "./queries.ts";
import { loadVaultProjects } from "./vault.ts";

const t0 = Date.now();
const db = openDb(DB_PATH);
const changed = ingestAll(db, CLAUDE_PROJECTS_DIR);
const counts = db
  .prepare(
    "SELECT (SELECT COUNT(*) FROM sessions) s, (SELECT COUNT(*) FROM agents) a, (SELECT COUNT(*) FROM events) e, (SELECT COUNT(*) FROM usage) u",
  )
  .get() as { s: number; a: number; e: number; u: number };
log.ok(`scan en ${Date.now() - t0} ms — ${changed.size} sesiones actualizadas`);
log.info(`   sesiones=${counts.s} agentes=${counts.a} eventos=${counts.e} mensajes-con-uso=${counts.u}`);

const ov = overview(
  db,
  { vaultDir: VAULT_DIR, vault: loadVaultProjects(VAULT_DIR), departments: loadDepartments(VAULT_DIR) },
  3650,
);
for (const p of ov.projects) {
  const out = p.sessions.reduce((n, s) => n + s.tokens.output, 0);
  log.info(`   ${p.mapped ? "★" : " "} ${p.name.padEnd(40)} ${String(p.sessions.length).padStart(3)} sesiones  ${p.status.padEnd(9)} out=${out}`);
}
