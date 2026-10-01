/**
 * Instalador de hooks HTTP de Company OS en el settings.json de Claude Code.
 *
 * Adaptado de `claudeHookInstaller.ts` de pixel-agents (MIT):
 *   Copyright (c) 2026 Pablo De Lucca
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 *   associated documentation files (the "Software"), to deal in the Software without restriction, including
 *   without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
 *   following conditions: The above copyright notice and this permission notice shall be included in all copies
 *   or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 *   (Texto completo: https://github.com/pablodelucca/pixel-agents/blob/main/LICENSE)
 *
 * Ideas conservadas: respaldo unico con COPYFILE_EXCL (sin respaldo no se escribe), escritura atomica
 * tmp + rename con verificacion de que nadie toco el archivo entre la lectura y el rename, reintentos ante
 * lecturas rotas, no tocar hooks ajenos. Diferencias: aqui los hooks son `type: "http"` (sin script) y se
 * identifican por URL (127.0.0.1|localhost + ruta `/hooks/<Evento>`).
 */
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

/** Los 11 eventos que ya estaban instalados + los 4 nuevos (error de herramienta y equipos). */
export const HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Notification",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
] as const;

export const BACKUP_SUFFIX = ".company-os.backup";
export const TMP_SUFFIX = ".company-os-tmp";
const HOOK_TIMEOUT_S = 2;
const MUTATE_ATTEMPTS = 3;
const RETRY_DELAY_MS = 100;

type Hook = { type?: string; url?: string; command?: string; timeout?: number; [k: string]: unknown };
type Entry = { matcher?: string; hooks?: Hook[]; [k: string]: unknown };
export type Settings = { hooks?: Record<string, Entry[]>; [k: string]: unknown };

export interface InstallOptions {
  /** Ruta del settings.json (obligatoria: el CLI decide el valor por defecto). */
  settingsPath: string;
  port: number;
  token: string;
}

export interface HookStatus {
  settingsExists: boolean;
  /** Evento -> "ok" (URL actual), "desactualizado" (otro token/puerto/duplicado) o "falta". */
  events: Record<string, "ok" | "desactualizado" | "falta">;
  /** Eventos fuera de la lista actual que aun tienen un hook nuestro (se limpian con install/uninstall). */
  extra: string[];
  backupExists: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Es un hook HTTP de Company OS? (loopback + `/hooks/<Evento>`, sin mirar puerto ni token: asi se reemplazan los viejos.) */
export function isOurHook(h: unknown): boolean {
  if (!isObj(h) || h.type !== "http" || typeof h.url !== "string") return false;
  try {
    const u = new URL(h.url);
    return (
      u.protocol === "http:" &&
      (u.hostname === "127.0.0.1" || u.hostname === "localhost") &&
      /^\/hooks\/[A-Za-z]+$/.test(u.pathname)
    );
  } catch {
    return false;
  }
}

export function hookUrl(opts: Pick<InstallOptions, "port" | "token">, event: string): string {
  return `http://127.0.0.1:${opts.port}/hooks/${event}?t=${opts.token}`;
}

const desiredHook = (opts: Pick<InstallOptions, "port" | "token">, event: string): Hook => ({
  type: "http",
  url: hookUrl(opts, event),
  timeout: HOOK_TIMEOUT_S,
});

function readRaw(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export function parseSettings(raw: string | null): Settings {
  if (raw === null || raw.trim() === "") return {};
  let v: unknown;
  try {
    v = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (e) {
    throw new Error("No se pudo leer settings.json (JSON invalido); no se modifico nada", { cause: e });
  }
  if (!isObj(v)) throw new Error("settings.json no es un objeto JSON; no se modifico nada");
  return v as Settings;
}

/** Devuelve `hooks` validado (lo crea si falta). Lanza ante formas inesperadas: nunca adivinamos sobre datos ajenos. */
function hooksOf(s: Settings): Record<string, Entry[]> {
  if (s.hooks === undefined) s.hooks = {};
  if (!isObj(s.hooks)) throw new Error('settings.json: "hooks" no es un objeto; no se modifico nada');
  for (const [ev, entries] of Object.entries(s.hooks)) {
    if (!Array.isArray(entries)) throw new Error(`settings.json: hooks.${ev} no es una lista; no se modifico nada`);
  }
  return s.hooks;
}

/** Quita nuestros hooks de una lista de entradas, conservando los ajenos (y entradas mixtas sin los nuestros). */
function withoutOurs(entries: Entry[]): Entry[] {
  const out: Entry[] = [];
  for (const e of entries) {
    if (!isObj(e) || !Array.isArray(e.hooks) || !e.hooks.some(isOurHook)) {
      out.push(e);
      continue;
    }
    const rest = e.hooks.filter((h) => !isOurHook(h));
    if (rest.length > 0) out.push({ ...e, hooks: rest });
  }
  return out;
}

const ourHooksIn = (entries: Entry[]): Hook[] =>
  entries.flatMap((e) => (isObj(e) && Array.isArray(e.hooks) ? e.hooks.filter(isOurHook) : []));

/** Aplica la instalacion en memoria. Devuelve si cambio algo. Es idempotente: si ya esta bien, no toca el orden. */
export function applyInstall(s: Settings, opts: Pick<InstallOptions, "port" | "token">): boolean {
  const hooks = hooksOf(s);
  let changed = false;
  const wanted = new Set<string>(HOOK_EVENTS);
  for (const ev of Object.keys(hooks)) {
    const entries = hooks[ev]!;
    const ours = ourHooksIn(entries);
    if (ours.length === 0) continue;
    // Ya correcto: exactamente un hook nuestro, igual al deseado, y solo en su propia entrada.
    const alone = entries.some((e) => isObj(e) && Array.isArray(e.hooks) && e.hooks.length === 1 && isOurHook(e.hooks[0]));
    if (wanted.has(ev) && ours.length === 1 && alone && isDeepStrictEqual(ours[0], desiredHook(opts, ev))) continue;
    const cleaned = withoutOurs(entries);
    if (cleaned.length > 0) hooks[ev] = cleaned;
    else delete hooks[ev];
    changed = true;
  }
  for (const ev of HOOK_EVENTS) {
    const entries = hooks[ev] ?? [];
    if (ourHooksIn(entries).length > 0) continue; // ya correcto (lo verifico el bucle anterior)
    hooks[ev] = [...entries, { hooks: [desiredHook(opts, ev)] }];
    changed = true;
  }
  return changed;
}

/** Quita todos nuestros hooks. Si `hooks` queda vacio por esto, se elimina la clave. */
export function applyUninstall(s: Settings): boolean {
  const hooks = hooksOf(s);
  let changed = false;
  for (const ev of Object.keys(hooks)) {
    const entries = hooks[ev]!;
    if (ourHooksIn(entries).length === 0) continue;
    const cleaned = withoutOurs(entries);
    if (cleaned.length > 0) hooks[ev] = cleaned;
    else delete hooks[ev];
    changed = true;
  }
  if (changed && Object.keys(hooks).length === 0) delete s.hooks;
  // hooksOf pudo crear `hooks: {}` en un archivo que no lo tenia: no cuenta como cambio, pero lo dejamos limpio.
  if (!changed && isObj(s.hooks) && Object.keys(s.hooks).length === 0) delete s.hooks;
  return changed;
}

export function statusOf(s: Settings, opts: Pick<InstallOptions, "port" | "token">, backupExists = false): HookStatus {
  const hooks = isObj(s.hooks) ? (s.hooks as Record<string, unknown>) : {};
  const events: HookStatus["events"] = {};
  for (const ev of HOOK_EVENTS) {
    const entries = Array.isArray(hooks[ev]) ? (hooks[ev] as Entry[]) : [];
    const ours = ourHooksIn(entries);
    events[ev] = ours.length === 0 ? "falta" : ours.length === 1 && isDeepStrictEqual(ours[0], desiredHook(opts, ev)) ? "ok" : "desactualizado";
  }
  const known = new Set<string>(HOOK_EVENTS);
  const extra = Object.keys(hooks).filter((ev) => !known.has(ev) && Array.isArray(hooks[ev]) && ourHooksIn(hooks[ev] as Entry[]).length > 0);
  return { settingsExists: true, events, extra, backupExists };
}

class ConcurrentWriteError extends Error {
  constructor() {
    super("settings.json cambio mientras se escribia; se reintenta");
  }
}

/** Copia unica: si ya existe un respaldo (archivo regular) no se pisa. Sin respaldo no se escribe: cualquier fallo lanza. */
function backupOnce(settingsPath: string): void {
  if (!existsSync(settingsPath)) return;
  const backup = settingsPath + BACKUP_SUFFIX;
  try {
    copyFileSync(settingsPath, backup, constants.COPYFILE_EXCL);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    let ok = false;
    try {
      ok = statSync(backup).isFile();
    } catch {
      ok = false;
    }
    if (!ok) throw new Error(`${backup} existe pero no es un archivo regular: no hay respaldo posible; muevelo o borralo`, { cause: e });
  }
}

function writeAtomic(path: string, settings: Settings, expectedRaw: string | null): void {
  const tmp = path + TMP_SUFFIX;
  rmSync(tmp, { force: true });
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  backupOnce(path);
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const eol = expectedRaw === null || expectedRaw.endsWith("\n") ? "\n" : "";
  try {
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + eol, { encoding: "utf8", mode: 0o600 });
    chmodSync(tmp, mode);
    if (readRaw(path) !== expectedRaw) throw new ConcurrentWriteError();
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Lectura-modificacion-escritura protegida. Devuelve si se escribio. */
async function mutate(path: string, fn: (s: Settings) => boolean): Promise<boolean> {
  let last: Error | null = null;
  for (let i = 0; i < MUTATE_ATTEMPTS; i++) {
    if (i > 0) await sleep(RETRY_DELAY_MS);
    let raw: string | null;
    let settings: Settings;
    try {
      raw = readRaw(path);
      settings = parseSettings(raw);
    } catch (e) {
      last = e as Error;
      continue; // una lectura rota puede ser una escritura a medias de Claude Code
    }
    if (!fn(settings)) return false;
    try {
      writeAtomic(path, settings, raw);
      return true;
    } catch (e) {
      if (!(e instanceof ConcurrentWriteError)) throw e;
      last = e;
    }
  }
  throw last ?? new Error("no se pudo actualizar settings.json");
}

export const installHooks = (o: InstallOptions): Promise<boolean> => mutate(o.settingsPath, (s) => applyInstall(s, o));
export const uninstallHooks = (settingsPath: string): Promise<boolean> => mutate(settingsPath, (s) => applyUninstall(s));

export function hooksStatus(settingsPath: string, o: Pick<InstallOptions, "port" | "token">): HookStatus {
  const raw = readRaw(settingsPath);
  const backupExists = existsSync(settingsPath + BACKUP_SUFFIX);
  if (raw === null) {
    const events: HookStatus["events"] = {};
    for (const ev of HOOK_EVENTS) events[ev] = "falta";
    return { settingsExists: false, events, extra: [], backupExists };
  }
  return statusOf(parseSettings(raw), o, backupExists);
}
