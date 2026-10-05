import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";

/**
 * Defensa contra DNS rebinding: una web externa puede apuntar su dominio a 127.0.0.1 y hablar con la API
 * local desde el navegador, pero el header `Host` seguira siendo el de ella. Solo se aceptan
 * `127.0.0.1:<puerto>` y `localhost:<puerto>` (sin distinguir mayusculas). El header ausente tambien se
 * rechaza; si el servidor no lo expone (pruebas con `app.request`), se usa la autoridad de la URL, que
 * @hono/node-server construye precisamente a partir de `Host`.
 */
export function allowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

export const REMOTE_COOKIE = "cos_key";
const COOKIE_MAX_AGE = 30 * 24 * 3600;

const keyOk = (given: string | undefined, expected: string): boolean => {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

function hostOf(c: Context): string | undefined {
  const host = c.req.header("host");
  if (host !== undefined) return host;
  try {
    return new URL(c.req.url).host;
  } catch {
    return undefined;
  }
}

const under = (path: string, prefix: string): boolean => path === prefix || path.startsWith(prefix + "/");

/**
 * Host local: pasa siempre. Host ajeno (el tunel del celular u otra web):
 * - `/hooks` nunca: los hooks solo llegan de esta maquina.
 * - acceso remoto apagado (`remoteKey()` null): `/api` 403 y la web estatica (sin datos) se sirve.
 * - acceso remoto encendido: todo exige la clave. El enlace trae `?k=<clave>` una vez; se guarda en una
 *   cookie HttpOnly/Secure/SameSite=Lax (una web ajena no puede mandar POST con ella) y se quita de la URL.
 */
export function hostGuard(port: number, remoteKey?: () => string | null): MiddlewareHandler {
  return async (c, next) => {
    if (allowedHost(hostOf(c), port)) return next();
    const path = c.req.path;
    const isApi = under(path, "/api");
    const key = remoteKey?.() ?? null;
    if (under(path, "/hooks") || (!key && isApi)) return c.json({ error: "host no permitido" }, 403);
    if (!key) return next();

    if (keyOk(getCookie(c, REMOTE_COOKIE), key)) return next();
    if (keyOk(c.req.query("k"), key)) {
      setCookie(c, REMOTE_COOKIE, key, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: COOKIE_MAX_AGE });
      const url = new URL(c.req.url);
      url.searchParams.delete("k");
      c.header("Referrer-Policy", "no-referrer");
      return c.redirect(url.pathname + url.search + url.hash, 302);
    }
    if (isApi) return c.json({ error: "falta la clave de acceso remoto" }, 401);
    return c.text("Company OS: abre el enlace completo que te mandaron (trae la clave).", 401);
  };
}
