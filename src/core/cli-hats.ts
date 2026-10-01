import { join } from "node:path";
import { AGENTS_DIR, VAULT_DIR } from "./config.ts";
import { installHats, loadHats } from "./hats.ts";
import { log } from "./log.ts";

const vaultHats = join(VAULT_DIR, "_empresa", "hats");
const defaults = join(import.meta.dirname, "..", "..", "hats");
const cmd = process.argv[2] ?? "install";

if (cmd === "list") {
  const hats = loadHats(vaultHats);
  if (hats.length === 0) log.warn(`no hay HATs en ${vaultHats} — corre \`npm run hats\` para sembrarlos`);
  for (const h of hats) log.info(`   ${h.name.padEnd(20)} ${(h.department ?? "?").padEnd(11)} ${(h.model ?? "inherit").padEnd(7)} ${h.tools ? "herramientas limitadas" : "todas las herramientas"}`);
} else if (cmd === "install") {
  const r = installHats(defaults, vaultHats, AGENTS_DIR);
  if (r.seeded.length) log.ok(`vault sembrado con ${r.seeded.length} HATs base: ${r.seeded.join(", ")}`);
  log.ok(`${r.installed.length} HATs instalados en ${AGENTS_DIR}: ${r.installed.join(", ")}`);
  for (const s of r.skipped) log.warn(`omitido ${s}: ya existe un agente con ese nombre que no es de Company OS`);
  log.info("   Edita los HATs en el vault y vuelve a correr `npm run hats` para actualizarlos.");
} else {
  log.error(`comando desconocido: ${cmd} (usa: install | list)`);
  process.exitCode = 1;
}
