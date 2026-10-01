import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DATA_DIR = join(import.meta.dirname, "..", "..", "data");
export const HOOK_TOKEN_FILE = join(DATA_DIR, "hook-token.txt");

/** Lee el token de los hooks; si no existe lo crea (16 bytes aleatorios en hex). */
export function loadOrCreateHookToken(file: string = HOOK_TOKEN_FILE): string {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, randomBytes(16).toString("hex"));
  }
  return readFileSync(file, "utf8").trim();
}
