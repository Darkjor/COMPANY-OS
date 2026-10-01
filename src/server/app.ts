import { timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, statSync } from "node:fs";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { DB } from "../core/db.ts";
import { listDeliverables, markSeen } from "../core/deliverables.ts";
import { recordHook, sanitizeHook } from "../core/hooks.ts";
import { log } from "../core/log.ts";
import { overview, projectDetail, sessionDetail, type Ctx } from "../core/queries.ts";
import { readVaultText } from "../core/vault.ts";

export type Listener = (sessionIds: string[]) => void;

export interface AppDeps {
  db: DB;
  vaultDir: string;
  /** Vault/department/HAT context, cached by the caller. */
  ctx: () => Ctx;
  hookToken: string;
  /** Subscribe to "sessions changed" notifications (SSE). Returns the unsubscribe function. */
  subscribe: (l: Listener) => () => void;
  /** Notify listeners that these sessions changed (a hook arrived). */
  notify?: Listener;
  /** Raw hook payload log — debugging only (COMPANY_OS_HOOK_DEBUG=1). Null/undefined = off. */
  rawHookLog?: { file: string; maxBytes: number } | null;
}

/** Hooks are tiny; a body past this is junk or a huge tool_response we would discard anyway. */
const MAX_HOOK_BODY = 8 * 1024 * 1024;

const clipDeep = (v: unknown): unknown => {
  if (typeof v === "string") return v.length > 2000 ? v.slice(0, 2000) + "…[recortado]" : v;
  if (Array.isArray(v)) return v.slice(0, 50).map(clipDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipDeep(x)]));
  return v;
};

const tokenOk = (given: string | undefined, expected: string): boolean => {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

let rawCapWarned = false;
function appendRaw(cfg: { file: string; maxBytes: number }, event: string, receivedAt: string, payload: unknown): void {
  try {
    if (existsSync(cfg.file) && statSync(cfg.file).size >= cfg.maxBytes) {
      if (!rawCapWarned) log.warn(`log crudo de hooks lleno (${cfg.maxBytes} bytes): ya no se escribe más`);
      rawCapWarned = true;
      return;
    }
    appendFileSync(cfg.file, JSON.stringify({ receivedAt, event, payload: clipDeep(payload) }) + "\n");
  } catch (err) {
    log.warn(`no se pudo guardar el log crudo de hooks: ${String(err)}`);
  }
}

const param = (v: string | undefined, max = 200): string | undefined => (v && v.length <= max ? v : undefined);

export function createApp(deps: AppDeps): Hono {
  const { db, vaultDir } = deps;
  const app = new Hono();

  app.get("/api/overview", (c) => {
    const days = Number(c.req.query("days") ?? 30);
    return c.json(overview(db, deps.ctx(), Number.isFinite(days) && days > 0 ? days : 30));
  });

  app.get("/api/projects/:key", (c) => {
    const detail = projectDetail(db, deps.ctx(), c.req.param("key"));
    return detail ? c.json(detail) : c.json({ error: "not found" }, 404);
  });

  app.get("/api/sessions/:id", (c) => {
    const detail = sessionDetail(db, deps.ctx(), c.req.param("id"));
    return detail ? c.json(detail) : c.json({ error: "not found" }, 404);
  });

  /**
   * Claude Code HTTP hooks. Contract from the hooks docs: answer 200 `{}` fast and never fail on
   * bad input — a failure here must never block Claude. The token in the query string keeps other
   * local processes from injecting fake events. Only allow-listed fields are stored.
   */
  app.post("/hooks/:event", async (c) => {
    if (!tokenOk(c.req.query("t"), deps.hookToken)) return c.json({}, 403);
    const event = c.req.param("event");
    const receivedAt = new Date().toISOString();
    let payload: unknown = null;
    try {
      const len = Number(c.req.header("content-length") ?? 0);
      if (len > MAX_HOOK_BODY) return c.json({});
      const text = await c.req.text();
      if (text.length <= MAX_HOOK_BODY) payload = JSON.parse(text);
    } catch (err) {
      log.warn(`hook ${event.slice(0, 40)} sin JSON válido: ${String(err)}`);
    }
    if (deps.rawHookLog) appendRaw(deps.rawHookLog, event, receivedAt, payload);
    const rec = sanitizeHook(event, payload);
    if (rec) {
      try {
        const sessionId = recordHook(db, vaultDir, rec, receivedAt); // not inside notify?.(): optional calls skip their arguments
        deps.notify?.([sessionId]);
      } catch (err) {
        log.warn(`no se pudo guardar el hook ${rec.event}: ${String(err)}`);
      }
    }
    return c.json({});
  });

  app.get("/api/deliverables", (c) => {
    const limit = Number(c.req.query("limit") ?? 100);
    const list = listDeliverables(db, vaultDir, {
      project: param(c.req.query("project")),
      session: param(c.req.query("session")),
      limit: Number.isFinite(limit) ? limit : 100,
    });
    return c.json({ deliverables: list });
  });

  /** Shared "seen" mark: opening a deliverable on any device clears it on all of them. */
  app.post("/api/deliverables/seen", async (c) => {
    // Requiring JSON forces a CORS preflight, so another web page cannot fire this blindly.
    if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return c.json({ error: "se espera application/json" }, 415);
    }
    let body: unknown = null;
    try {
      if (Number(c.req.header("content-length") ?? 0) <= 4096) body = await c.req.json();
    } catch {
      body = null;
    }
    const raw = body && typeof body === "object" ? (body as { path?: unknown }).path : null;
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 1024 || raw.includes("\u0000")) {
      return c.json({ error: "path requerido" }, 400);
    }
    const seen = markSeen(db, raw.replace(/[\\]/g, "/"), new Date().toISOString());
    if (!seen) return c.json({ error: "entregable desconocido" }, 404);
    deps.notify?.([seen.sessionId]);
    return c.json({ path: raw.replace(/[\\]/g, "/"), seenAt: seen.seenAt });
  });

  app.get("/api/vault/file", (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path requerido" }, 400);
    try {
      const file = readVaultText(vaultDir, path);
      return file ? c.json(file) : c.json({ error: "no disponible" }, 404);
    } catch (err) {
      log.warn(`lectura de vault falló (${path.slice(0, 200)}): ${String(err)}`);
      return c.json({ error: "no disponible" }, 404);
    }
  });

  app.get("/api/stream", (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = deps.subscribe((ids) => {
        void stream.writeSSE({ event: "changed", data: JSON.stringify(ids) });
      });
      stream.onAbort(unsubscribe);
      while (!stream.aborted) {
        await stream.writeSSE({ event: "ping", data: "" });
        await stream.sleep(15_000);
      }
      unsubscribe();
    }),
  );

  return app;
}
