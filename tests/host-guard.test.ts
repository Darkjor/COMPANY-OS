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

describe("acceso remoto (tunel al celular)", () => {
  let key: string | null = "k".repeat(48);
  const remote = createApp({ db: openDb(":memory:"), vaultDir: "", ctx: () => ctx, hookToken: "tok", port: 4747, subscribe: () => () => {}, remoteKey: () => key });
  remote.get("/", (c) => c.text("web"));
  const TUNNEL = "abc.trycloudflare.com";
  const req = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
    remote.request(`https://${TUNNEL}${path}`, { ...init, headers: { host: TUNNEL, ...headers } });

  it("sin clave: 401 en la web y en la API", async () => {
    key = "k".repeat(48);
    expect((await req("/")).status).toBe(401);
    expect((await req("/api/deliverables")).status).toBe(401);
    expect((await req("/api/deliverables?k=mala")).status).toBe(401);
  });

  it("el enlace con ?k= deja una cookie segura y redirige sin la clave", async () => {
    const res = await req("/?k=" + key + "&x=1");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?x=1");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`cos_key=${key}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it("con la cookie: web, API y POST de 'visto' pasan", async () => {
    const h = { cookie: `cos_key=${key}` };
    expect((await req("/", h)).status).toBe(200);
    expect((await req("/api/deliverables", h)).status).toBe(200);
    const seen = await req("/api/deliverables/seen", { ...h, "content-type": "application/json" }, { method: "POST", body: JSON.stringify({ path: "x.md" }) });
    expect(seen.status).toBe(404); // paso el guard; el entregable no existe
  });

  it("/hooks nunca se abre por el tunel, ni con cookie", async () => {
    const res = await req("/hooks/Stop?t=tok", { cookie: `cos_key=${key}`, "content-type": "application/json" }, { method: "POST", body: "{}" });
    expect(res.status).toBe(403);
  });

  it("al borrar la clave se corta el acceso aunque la cookie siga", async () => {
    key = null;
    expect((await req("/api/deliverables", { cookie: "cos_key=" + "k".repeat(48) })).status).toBe(403);
    key = "k".repeat(48);
  });

  it("el Host local no necesita clave", async () => {
    expect((await remote.request("http://127.0.0.1:4747/api/deliverables", { headers: { host: "127.0.0.1:4747" } })).status).toBe(200);
  });
});
