import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BACKUP_SUFFIX,
  HOOK_EVENTS,
  TMP_SUFFIX,
  hooksStatus,
  installHooks,
  isOurHook,
  uninstallHooks,
} from "../src/core/hook-installer.ts";

let dir: string;
let file: string;
const opts = () => ({ settingsPath: file, port: 4747, token: "tok123" });
const read = () => JSON.parse(readFileSync(file, "utf8")) as { hooks?: Record<string, { matcher?: string; hooks: { type: string; url?: string; command?: string }[] }[]>; [k: string]: unknown };
const oldUrl = (ev: string) => `http://127.0.0.1:4747/hooks/${ev}?t=oldtoken`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cos-hooks-"));
  file = join(dir, "settings.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("instalador de hooks", () => {
  it("instala los 15 eventos en un archivo que no existe", async () => {
    expect(await installHooks(opts())).toBe(true);
    const s = read();
    expect(Object.keys(s.hooks!).sort()).toEqual([...HOOK_EVENTS].sort());
    expect(HOOK_EVENTS).toHaveLength(15);
    expect(s.hooks!.TaskCreated![0]!.hooks[0]).toEqual({ type: "http", url: "http://127.0.0.1:4747/hooks/TaskCreated?t=tok123", timeout: 2 });
    expect(existsSync(file + BACKUP_SUFFIX)).toBe(false); // no habia nada que respaldar
    expect(existsSync(file + TMP_SUFFIX)).toBe(false);
  });

  it("es idempotente: la segunda corrida no escribe ni cambia el archivo", async () => {
    await installHooks(opts());
    const before = readFileSync(file, "utf8");
    expect(await installHooks(opts())).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("conserva campos y hooks ajenos, y reemplaza (no duplica) los viejos de Company OS", async () => {
    const foreign = { matcher: "Bash", hooks: [{ type: "command", command: "echo hola" }] };
    const mixed = { hooks: [{ type: "command", command: "otro.sh" }, { type: "http", url: oldUrl("Stop"), timeout: 2 }] };
    writeFileSync(
      file,
      JSON.stringify({
        permissions: { allow: ["Bash(ls)"] },
        hooks: {
          PreToolUse: [foreign, { hooks: [{ type: "http", url: oldUrl("PreToolUse"), timeout: 2 }] }],
          Stop: [mixed],
          Legacy: [{ hooks: [{ type: "http", url: oldUrl("Legacy"), timeout: 2 }] }],
          // Ajeno aunque sea http: otro host
          SessionEnd: [{ hooks: [{ type: "http", url: "https://ejemplo.com/hooks/SessionEnd" }] }],
        },
      }) + "\n",
    );
    expect(await installHooks(opts())).toBe(true);
    const s = read();
    expect(s.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(s.hooks!.PreToolUse).toHaveLength(2);
    expect(s.hooks!.PreToolUse![0]).toEqual(foreign);
    expect(s.hooks!.PreToolUse![1]!.hooks[0]!.url).toBe("http://127.0.0.1:4747/hooks/PreToolUse?t=tok123");
    expect(s.hooks!.Stop![0]).toEqual({ hooks: [{ type: "command", command: "otro.sh" }] }); // la entrada mixta perdio solo el nuestro
    expect(s.hooks!.Stop).toHaveLength(2);
    expect(s.hooks!.Legacy).toBeUndefined(); // evento fuera de la lista: se limpia
    expect(s.hooks!.SessionEnd).toHaveLength(2); // el ajeno se queda
    expect(s.hooks!.SessionEnd![0]!.hooks[0]!.url).toBe("https://ejemplo.com/hooks/SessionEnd");
    const ours = Object.values(s.hooks!).flat().flatMap((e) => e.hooks).filter(isOurHook);
    expect(ours).toHaveLength(15);
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  });

  it("respaldo unico: se crea una vez con el contenido original y no se pisa", async () => {
    const original = JSON.stringify({ model: "x", hooks: { Stop: [{ hooks: [{ type: "http", url: oldUrl("Stop") }] }] } });
    writeFileSync(file, original);
    await installHooks(opts());
    expect(readFileSync(file + BACKUP_SUFFIX, "utf8")).toBe(original);
    await installHooks({ ...opts(), token: "nuevo" }); // segunda modificacion real
    expect(readFileSync(file + BACKUP_SUFFIX, "utf8")).toBe(original);
    expect(read().hooks!.Stop![0]!.hooks[0]!.url).toContain("t=nuevo");
  });

  it("si el respaldo es un directorio, no escribe nada", async () => {
    writeFileSync(file, '{"a":1}');
    mkdirSync(file + BACKUP_SUFFIX);
    await expect(installHooks(opts())).rejects.toThrow(); // EPERM en Windows, "no es regular" en otros
    expect(readFileSync(file, "utf8")).toBe('{"a":1}');
    expect(existsSync(file + TMP_SUFFIX)).toBe(false);
  });

  it("JSON invalido o forma inesperada: error y el archivo queda intacto", async () => {
    writeFileSync(file, "{ roto");
    await expect(installHooks(opts())).rejects.toThrow(/JSON/);
    expect(readFileSync(file, "utf8")).toBe("{ roto");
    writeFileSync(file, JSON.stringify({ hooks: { Stop: "no soy lista" } }));
    await expect(installHooks(opts())).rejects.toThrow(/hooks\.Stop/);
    expect(readFileSync(file, "utf8")).toBe(JSON.stringify({ hooks: { Stop: "no soy lista" } }));
    writeFileSync(file, JSON.stringify({ hooks: [] }));
    await expect(installHooks(opts())).rejects.toThrow(/hooks/);
  });

  it("uninstall quita solo lo nuestro, deja lo ajeno y es idempotente", async () => {
    const foreign = { matcher: "Bash", hooks: [{ type: "command", command: "echo hola" }] };
    writeFileSync(file, JSON.stringify({ theme: "dark", hooks: { PreToolUse: [foreign] } }));
    await installHooks(opts());
    expect(await uninstallHooks(file)).toBe(true);
    expect(read()).toEqual({ theme: "dark", hooks: { PreToolUse: [foreign] } });
    expect(await uninstallHooks(file)).toBe(false);
  });

  it("uninstall elimina la clave hooks si solo habia hooks nuestros, y no crea archivo si no existe", async () => {
    await installHooks(opts());
    await uninstallHooks(file);
    expect(read()).toEqual({});
    const other = join(dir, "no-existe.json");
    expect(await uninstallHooks(other)).toBe(false);
    expect(existsSync(other)).toBe(false);
  });

  it("status distingue ok, desactualizado y falta", async () => {
    writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "http", url: oldUrl("Stop"), timeout: 2 }] }] } }));
    let st = hooksStatus(file, { port: 4747, token: "tok123" });
    expect(st.events.Stop).toBe("desactualizado");
    expect(st.events.PreToolUse).toBe("falta");
    await installHooks(opts());
    st = hooksStatus(file, { port: 4747, token: "tok123" });
    expect(Object.values(st.events).every((v) => v === "ok")).toBe(true);
    expect(st.backupExists).toBe(true);
    expect(hooksStatus(join(dir, "nada.json"), { port: 4747, token: "t" }).settingsExists).toBe(false);
  });
});
