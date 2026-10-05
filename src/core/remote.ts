import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./hook-token.ts";

/**
 * Acceso remoto (celular) por un tunel: la clave vive en data/remote-key.txt. Si el archivo no existe el
 * acceso remoto esta apagado. Borrarlo (o `npm run remote -- off`) corta todos los enlaces al instante,
 * sin reiniciar el servidor: se relee cada pocos segundos.
 */
export const REMOTE_KEY_FILE = join(DATA_DIR, "remote-key.txt");
/** Ultimo enlace publicado por `npm run remote` (para mostrarlo/reenviarlo). */
export const REMOTE_URL_FILE = join(DATA_DIR, "remote-url.txt");

export function createRemoteKey(file: string = REMOTE_KEY_FILE, rotate = false): string {
  if (rotate || !existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, randomBytes(24).toString("hex"));
  }
  return readFileSync(file, "utf8").trim();
}

export function removeRemoteKey(file: string = REMOTE_KEY_FILE): void {
  rmSync(file, { force: true });
}

/** Lector con cache corta: el guard lo llama en cada peticion no local. */
export function remoteKeyReader(file: string = REMOTE_KEY_FILE, ttlMs = 5000): () => string | null {
  let cache: { at: number; key: string | null } | null = null;
  return () => {
    if (!cache || Date.now() - cache.at > ttlMs) {
      let key: string | null = null;
      try {
        key = existsSync(file) ? readFileSync(file, "utf8").trim() || null : null;
      } catch {
        key = null;
      }
      cache = { at: Date.now(), key };
    }
    return cache.key;
  };
}
