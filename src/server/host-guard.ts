import type { MiddlewareHandler } from "hono";

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

export function hostGuard(port: number): MiddlewareHandler {
  return async (c, next) => {
    let host = c.req.header("host");
    if (host === undefined) {
      try {
        host = new URL(c.req.url).host;
      } catch {
        host = undefined;
      }
    }
    if (!allowedHost(host, port)) return c.json({ error: "host no permitido" }, 403);
    await next();
  };
}
