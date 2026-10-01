import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VAULT_DIR } from "./config.ts";
import { loadHats } from "./hats.ts";
import { log } from "./log.ts";
import { SpawnRefused, findClaudeBinary, planSpawn } from "./spawn.ts";

// Uso: npm run spawn -- <hat> <brief.md> [--model sonnet|opus] [--cwd <dir>] [--permitir-bash]
const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv.splice(i, 2)[1] : undefined;
};
const model = flag("--model");
const cwd = flag("--cwd") ?? process.cwd();
const allowBash = argv.includes("--permitir-bash");
const [hatName, briefPath] = argv.filter((a) => !a.startsWith("--"));

if (!hatName || !briefPath) {
  log.error("uso: npm run spawn -- <hat> <brief.md> [--model sonnet|opus] [--cwd <dir>] [--permitir-bash]");
  process.exit(1);
}
if (!existsSync(briefPath)) {
  log.error(`no existe el brief: ${briefPath}`);
  process.exit(1);
}

const hats = loadHats(join(VAULT_DIR, "_empresa", "hats"));
let plan;
try {
  plan = planSpawn(hats.find((h) => h.name === hatName), readFileSync(briefPath, "utf8"), { model, vaultDir: VAULT_DIR, allowBash });
} catch (err) {
  if (err instanceof SpawnRefused) {
    log.error(`lanzamiento rechazado: ${err.message}. HATs disponibles: ${hats.map((h) => h.name).join(", ")}`);
    process.exit(2);
  }
  throw err;
}
for (const w of plan.warnings) log.warn(w);

const bin = findClaudeBinary();
if (!bin) {
  log.error("no encontré el ejecutable de Claude Code (define CLAUDE_BIN)");
  process.exit(1);
}

const runsDir = join(import.meta.dirname, "..", "..", "data", "runs");
mkdirSync(runsDir, { recursive: true });
const logFile = join(runsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${hatName}.log`);
const out = createWriteStream(logFile);
log.ok(`lanzando ${hatName} con ${plan.model} en ${cwd} (registro: ${logFile})`);

const child = spawn(bin, plan.args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (d) => {
  process.stdout.write(d);
  out.write(d);
});
child.stderr.on("data", (d) => out.write(d));
child.on("close", (code) => {
  out.end();
  if (code === 0) log.ok(`${hatName} terminó`);
  else log.error(`${hatName} terminó con código ${code}`);
  process.exitCode = code ?? 1;
});
