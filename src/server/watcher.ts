import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import type { DB } from "../core/db.ts";
import { classify, ingestAll, ingestFile } from "../core/ingest.ts";
import { log } from "../core/log.ts";

type OnChange = (sessionIds: string[]) => void;

/**
 * Low-latency fs.watch (recursive works natively on Windows) plus a periodic sweep
 * as safety net — if a watch event is missed, the sweep picks it up within seconds.
 */
export function startWatcher(db: DB, root: string, onChange: OnChange, sweepMs = 3000): () => void {
  const pending = new Map<string, NodeJS.Timeout>();

  const flush = (file: string) => {
    pending.delete(file);
    const ref = classify(root, file);
    if (!ref) return;
    try {
      const sid = ingestFile(db, ref);
      if (sid) onChange([sid]);
    } catch (err) {
      log.warn(`ingesta falló para ${file}: ${String(err)}`);
    }
  };

  let watcher: ReturnType<typeof watch> | null = null;
  if (existsSync(root)) {
    try {
      watcher = watch(root, { recursive: true }, (_evt, name) => {
        if (!name) return;
        const rel = name.toString().replace(/\.meta\.json$/, ".jsonl");
        if (!rel.endsWith(".jsonl")) return;
        const file = join(root, rel);
        clearTimeout(pending.get(file));
        pending.set(file, setTimeout(() => flush(file), 150));
      });
    } catch (err) {
      log.warn(`fs.watch no disponible, solo barrido periódico: ${String(err)}`);
    }
  } else {
    log.warn(`no existe ${root} — esperando a que Claude Code cree sesiones`);
  }

  const sweep = setInterval(() => {
    try {
      const changed = ingestAll(db, root);
      if (changed.size) onChange([...changed]);
    } catch (err) {
      log.warn(`barrido falló: ${String(err)}`);
    }
  }, sweepMs);

  return () => {
    watcher?.close();
    clearInterval(sweep);
    for (const t of pending.values()) clearTimeout(t);
  };
}
