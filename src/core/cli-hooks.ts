/**
 * npm run hooks -- install|uninstall|status [--settings <ruta>]
 * Por defecto actua sobre ~/.claude/settings.json (o COMPANY_OS_SETTINGS). Pasa --settings para probar con otro archivo.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { PORT } from "./config.ts";
import { BACKUP_SUFFIX, hooksStatus, installHooks, uninstallHooks } from "./hook-installer.ts";
import { loadOrCreateHookToken } from "./hook-token.ts";

const args = process.argv.slice(2);
const cmd = args[0];
const i = args.indexOf("--settings");
if (i >= 0 && !args[i + 1]) {
  console.error("--settings necesita una ruta");
  process.exit(2);
}
const settingsPath =
  (i >= 0 ? args[i + 1] : undefined) ?? process.env.COMPANY_OS_SETTINGS ?? join(homedir(), ".claude", "settings.json");

try {
  if (cmd === "install") {
    const changed = await installHooks({ settingsPath, port: PORT, token: loadOrCreateHookToken() });
    console.log(changed ? `Hooks instalados en ${settingsPath}` : `Sin cambios: los hooks ya estaban al dia en ${settingsPath}`);
    console.log(`Respaldo original: ${settingsPath + BACKUP_SUFFIX} (se crea una sola vez). Las sesiones de Claude Code ya abiertas toman el cambio al reiniciarse.`);
  } else if (cmd === "uninstall") {
    const changed = await uninstallHooks(settingsPath);
    console.log(changed ? `Hooks de Company OS quitados de ${settingsPath}` : `Sin cambios: no habia hooks de Company OS en ${settingsPath}`);
  } else if (cmd === "status") {
    const st = hooksStatus(settingsPath, { port: PORT, token: loadOrCreateHookToken() });
    console.log(`${settingsPath}${st.settingsExists ? "" : " (no existe)"} - respaldo: ${st.backupExists ? "si" : "no"}`);
    for (const [ev, s] of Object.entries(st.events)) console.log(`  ${s === "ok" ? "[ok]" : s === "falta" ? "[--]" : "[!!]"} ${ev.padEnd(20)} ${s}`);
    if (st.extra.length) console.log(`  eventos fuera de la lista con hook nuestro: ${st.extra.join(", ")}`);
    process.exitCode = Object.values(st.events).every((s) => s === "ok") ? 0 : 1;
  } else {
    console.error("Uso: npm run hooks -- install|uninstall|status [--settings <ruta>]");
    process.exit(2);
  }
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
}
