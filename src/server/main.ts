import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { CLAUDE_PROJECTS_DIR, DB_PATH, PORT, TEAMS_DIR, VAULT_DIR } from "../core/config.ts";
import { openDb } from "../core/db.ts";
import { ingestAll } from "../core/ingest.ts";
import { log } from "../core/log.ts";
import { loadDepartments } from "../core/departments.ts";
import { hatDepartments } from "../core/hats.ts";
import { type Ctx } from "../core/queries.ts";
import { loadTeams } from "../core/teams.ts";
import { loadVaultProjects } from "../core/vault.ts";
import { createApp, type Listener } from "./app.ts";
import { startWatcher } from "./watcher.ts";

const db = openDb(DB_PATH);
const t0 = Date.now();
ingestAll(db, CLAUDE_PROJECTS_DIR, { vaultDir: VAULT_DIR });
log.ok(`índice listo en ${Date.now() - t0} ms (${CLAUDE_PROJECTS_DIR})`);
log.ok(`vault: ${VAULT_DIR}`);

let ctxCache: { at: number; ctx: Ctx } | null = null;
function ctx(): Ctx {
  if (!ctxCache || Date.now() - ctxCache.at > 5000) {
    ctxCache = {
      at: Date.now(),
      ctx: {
        vaultDir: VAULT_DIR,
        vault: loadVaultProjects(VAULT_DIR),
        departments: loadDepartments(VAULT_DIR),
        hats: hatDepartments(join(VAULT_DIR, "_empresa", "hats")),
        teams: loadTeams(TEAMS_DIR),
      },
    };
  }
  return ctxCache.ctx;
}

const listeners = new Set<Listener>();
const notify: Listener = (ids) => {
  for (const l of listeners) l(ids);
};
startWatcher(db, CLAUDE_PROJECTS_DIR, notify, 3000, { vaultDir: VAULT_DIR });

const DATA_DIR = join(import.meta.dirname, "..", "..", "data");
const HOOK_TOKEN_FILE = join(DATA_DIR, "hook-token.txt");
if (!existsSync(HOOK_TOKEN_FILE)) writeFileSync(HOOK_TOKEN_FILE, randomBytes(16).toString("hex"));
const hookToken = readFileSync(HOOK_TOKEN_FILE, "utf8").trim();

// Raw payloads (prompts, commands, replies!) are only logged on purpose, and capped at 5 MB.
const debugRaw = process.env.COMPANY_OS_HOOK_DEBUG === "1";
if (debugRaw) log.warn("COMPANY_OS_HOOK_DEBUG=1: guardando payloads crudos de hooks en data/hooks-events.ndjson (máx. 5 MB)");

const app = createApp({
  db,
  vaultDir: VAULT_DIR,
  ctx,
  hookToken,
  notify,
  subscribe: (l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  rawHookLog: debugRaw ? { file: join(DATA_DIR, "hooks-events.ndjson"), maxBytes: 5 * 1024 * 1024 } : null,
});

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
