import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { CLAUDE_PROJECTS_DIR, DB_PATH, PORT, VAULT_DIR } from "../core/config.ts";
import { openDb } from "../core/db.ts";
import { ingestAll } from "../core/ingest.ts";
import { log } from "../core/log.ts";
import { loadDepartments } from "../core/departments.ts";
import { overview, projectDetail, sessionDetail, type Ctx } from "../core/queries.ts";
import { loadVaultProjects, readVaultText } from "../core/vault.ts";
import { startWatcher } from "./watcher.ts";

const db = openDb(DB_PATH);
const t0 = Date.now();
ingestAll(db, CLAUDE_PROJECTS_DIR);
log.ok(`índice listo en ${Date.now() - t0} ms (${CLAUDE_PROJECTS_DIR})`);
log.ok(`vault: ${VAULT_DIR}`);

let ctxCache: { at: number; ctx: Ctx } | null = null;
function ctx(): Ctx {
  if (!ctxCache || Date.now() - ctxCache.at > 5000) {
    ctxCache = {
      at: Date.now(),
      ctx: { vaultDir: VAULT_DIR, vault: loadVaultProjects(VAULT_DIR), departments: loadDepartments(VAULT_DIR) },
    };
  }
  return ctxCache.ctx;
}

type Listener = (sessionIds: string[]) => void;
const listeners = new Set<Listener>();
startWatcher(db, CLAUDE_PROJECTS_DIR, (ids) => {
  for (const l of listeners) l(ids);
});

const app = new Hono();

app.get("/api/overview", (c) => {
  const days = Number(c.req.query("days") ?? 30);
  return c.json(overview(db, ctx(), Number.isFinite(days) && days > 0 ? days : 30));
});

app.get("/api/projects/:key", (c) => {
  const detail = projectDetail(db, ctx(), c.req.param("key"));
  return detail ? c.json(detail) : c.json({ error: "not found" }, 404);
});

app.get("/api/sessions/:id", (c) => {
  const detail = sessionDetail(db, ctx(), c.req.param("id"));
  return detail ? c.json(detail) : c.json({ error: "not found" }, 404);
});

app.get("/api/vault/file", (c) => {
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path requerido" }, 400);
  try {
    const file = readVaultText(VAULT_DIR, path);
    return file ? c.json(file) : c.json({ error: "no disponible" }, 404);
  } catch (err) {
    log.warn(`lectura de vault falló (${path}): ${String(err)}`);
    return c.json({ error: "no disponible" }, 404);
  }
});

app.get("/api/stream", (c) =>
  streamSSE(c, async (stream) => {
    const listener: Listener = (ids) => {
      void stream.writeSSE({ event: "changed", data: JSON.stringify(ids) });
    };
    listeners.add(listener);
    stream.onAbort(() => {
      listeners.delete(listener);
    });
    while (!stream.aborted) {
      await stream.writeSSE({ event: "ping", data: "" });
      await stream.sleep(15_000);
    }
    listeners.delete(listener);
  }),
);

const dist = join(import.meta.dirname, "..", "..", "web", "dist");
if (existsSync(dist)) {
  const root = relative(process.cwd(), dist) || ".";
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ path: join(root, "index.html") }));
} else {
  app.get("/", (c) => c.text("Dashboard sin compilar — ejecuta `npm run build:web` (o `npm run dev:web`)."));
}

serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
  log.ok(`Company OS observando en http://127.0.0.1:${info.port}`);
});
