import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "./db.ts";
import { log } from "./log.ts";

export const BACKUP_KEEP = 7;
export const HOOK_EVENTS_KEEP_DAYS = 30;
export const MAINTENANCE_EVERY_MS = 24 * 60 * 60 * 1000;

const BACKUP_NAME = /^company-os-(\d{4}-\d{2}-\d{2})\.db$/;

const dayOf = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; // dia local: el que ve el usuario
};

/**
 * Copia consistente de la DB con `VACUUM INTO` a `<dir>/company-os-AAAA-MM-DD.db` y deja solo las `keep` mas recientes.
 * Si ya hay una del mismo dia, se reemplaza (se escribe a un temporal y se renombra, asi nunca queda una a medias).
 * Devuelve la ruta escrita.
 */
export function backupDb(db: DB, dir: string, now: Date = new Date(), keep: number = BACKUP_KEEP): string {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `company-os-${dayOf(now)}.db`);
  const tmp = join(dir, `.company-os-${dayOf(now)}.tmp`);
  rmSync(tmp, { force: true });
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  renameSync(tmp, target);
  pruneBackups(dir, keep);
  return target;
}

/** Borra los respaldos mas viejos (por la fecha en el nombre); ignora cualquier otro archivo. */
export function pruneBackups(dir: string, keep: number = BACKUP_KEEP): string[] {
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir).filter((n) => BACKUP_NAME.test(n)).sort();
  const doomed = names.slice(0, Math.max(0, names.length - keep));
  for (const n of doomed) rmSync(join(dir, n), { force: true });
  return doomed;
}

/** Poda `hook_events` a los ultimos `days` dias. No toca `hook_state` ni `deliverables`. Devuelve filas borradas. */
export function pruneHookEvents(db: DB, now: Date = new Date(), days: number = HOOK_EVENTS_KEEP_DAYS): number {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const res = db.prepare("DELETE FROM hook_events WHERE ts < ?").run(cutoff);
  return Number(res.changes);
}

/** Un ciclo: primero el respaldo (conserva lo que se va a podar), despues la poda. Nunca lanza. */
export function runMaintenance(db: DB, backupDir: string, now: Date = new Date()): void {
  try {
    const file = backupDb(db, backupDir, now);
    log.ok(`respaldo de la DB: ${file}`);
  } catch (err) {
    log.warn(`no se pudo respaldar la DB: ${String(err)}`);
  }
  try {
    const n = pruneHookEvents(db, now);
    if (n > 0) log.ok(`poda: ${n} hook_events de mas de ${HOOK_EVENTS_KEEP_DAYS} dias`);
  } catch (err) {
    log.warn(`no se pudo podar hook_events: ${String(err)}`);
  }
}

/** Corre un ciclo ya y luego cada 24 h. El temporizador no mantiene vivo el proceso. Devuelve la funcion que lo detiene. */
export function startMaintenance(db: DB, backupDir: string, everyMs: number = MAINTENANCE_EVERY_MS): () => void {
  runMaintenance(db, backupDir);
  const timer = setInterval(() => runMaintenance(db, backupDir), everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
