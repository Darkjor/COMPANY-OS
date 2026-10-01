import { describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.ts";
import type { Ctx } from "../src/core/queries.ts";
import { createApp } from "../src/server/app.ts";
import { allowedHost } from "../src/server/host-guard.ts";

const ctx: Ctx = { vaultDir: "", vault: [], departments: [], hats: new Map(), teams: [] } as unknown as Ctx;
const app = createApp({ db: openDb(":memory:"), vaultDir: "", ctx: () => ctx, hookToken: "tok", port: 4747, subscribe: () => () => {} });

const get = (path: string, host?: string) =>
  app.request(`http://127.0.0.1:4747${path}`, host === undefined ? {} : { headers: { host } });
const hook = (host?: string) =>
  app.request("http://127.0.0.1:4747/hooks/Stop?t=tok", {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json", ...(host === undefined ? {} : { host }) },
  });

describe("proteccion contra DNS rebinding", () => {
  it("allowedHost acepta solo 127.0.0.1:<puerto> y localhost:<puerto>", () => {
    expect(allowedHost("127.0.0.1:4747", 4747)).toBe(true);
    expect(allowedHost("localhost:4747", 4747)).toBe(true);
    expect(allowedHost("LOCALHOST:4747", 4747)).toBe(true);
    for (const h of [undefined, "", "evil.com", "evil.com:4747", "127.0.0.1", "localhost", "127.0.0.1:4748", "localhost:80", "127.0.0.1:4747.evil.com", "evil.com:4747@127.0.0.1:4747", "[::1]:4747", "0.0.0.0:4747", "localhost.evil.com:4747"]) {
      expect(allowedHost(h, 4747), String(h)).toBe(false);
    }
  });

  it("/api/* con Host valido responde normal", async () => {
    expect((await get("/api/deliverables", "127.0.0.1:4747")).status).toBe(200);
    expect((await get("/api/deliverables", "localhost:4747")).status).toBe(200);
  });

  it("/api/* con Host ajeno o puerto equivocado -> 403, tambien las rutas desconocidas y el SSE", async () => {
    for (const host of ["evil.com", "evil.com:4747", "127.0.0.1:9999", "localhost"]) {
      for (const path of ["/api/deliverables", "/api/overview", "/api/vault/file?path=a.md", "/api/stream", "/api/no-existe"]) {
        const res = await get(path, host);
        expect(res.status, `${host} ${path}`).toBe(403);
        expect(await res.json()).toEqual({ error: "host no permitido" });
      }
    }
  });

  it("POST /api/deliverables/seen y /hooks/* tambien se protegen", async () => {
    const seen = await app.request("http://127.0.0.1:4747/api/deliverables/seen", {
      method: "POST",
      body: JSON.stringify({ path: "Proyectos/x/desarrollo/a.md" }),
      headers: { "content-type": "application/json", host: "evil.com:4747" },
    });
    expect(seen.status).toBe(403);
    expect((await hook("evil.com:4747")).status).toBe(403);
    expect((await hook("127.0.0.1:4747")).status).toBe(200);
  });

  it("el token sigue siendo obligatorio aunque el Host sea bueno", async () => {
    const res = await app.request("http://127.0.0.1:4747/hooks/Stop?t=mal", { method: "POST", body: "{}" });
    expect(res.status).toBe(403);
  });
});
