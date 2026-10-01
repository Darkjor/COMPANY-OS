import { describe, expect, it } from "vitest";
import { parseHat } from "../src/core/hats.ts";
import { SpawnRefused, planSpawn } from "../src/core/spawn.ts";

const investigador = parseHat(
  "---\nname: investigador\ndescription: d\nmodel: sonnet\ntools: Read, WebSearch, WebFetch, Write\nmodelos_prohibidos: haiku\ndepartamento: research\n---\ncuerpo",
  "investigador.md",
)!;
const dev = parseHat("---\nname: dev-backend\ndescription: d\nmodel: sonnet\ndepartamento: desarrollo\n---\ncuerpo", "dev.md")!;
const brief = "## Objetivo\nX\n## Contexto\nY mínimo necesario para la tarea.\n## Entregable\nProyectos/demo/research/2026-10-01-x/informe.md";

describe("planSpawn", () => {
  it("refuses a session without a HAT", () => {
    expect(() => planSpawn(undefined, brief, { vaultDir: "V" })).toThrow(SpawnRefused);
  });

  it("refuses a model the HAT forbids (haiku for research)", () => {
    expect(() => planSpawn(investigador, brief, { vaultDir: "V", model: "claude-haiku-4-5" })).toThrow(/prohibido/);
  });

  it("uses the HAT's model and tools by default", () => {
    const p = planSpawn(investigador, brief, { vaultDir: "V" });
    expect(p.model).toBe("sonnet");
    expect(p.args).toEqual(expect.arrayContaining(["--agent", "investigador", "--allowedTools", "Read WebSearch WebFetch Write"]));
    expect(p.warnings).toEqual([]);
  });

  it("dev HATs run without Bash unless the human allows it", () => {
    const noBash = planSpawn(dev, brief, { vaultDir: "V" });
    expect(noBash.args[noBash.args.indexOf("--allowedTools") + 1]).not.toContain("Bash");
    expect(noBash.warnings.join()).toMatch(/SIN Bash/);
    const withBash = planSpawn(dev, brief, { vaultDir: "V", allowBash: true });
    expect(withBash.args[withBash.args.indexOf("--allowedTools") + 1]).toContain("Bash");
  });

  it("warns when the brief misses required sections and refuses an empty one", () => {
    expect(planSpawn(investigador, "Investiga cualquier cosa sobre el mercado inmobiliario de Tulum y dame un informe completo por favor.", { vaultDir: "V" }).warnings.join()).toMatch(/faltan secciones/);
    expect(() => planSpawn(investigador, "hola", { vaultDir: "V" })).toThrow(/brief/);
  });
});
