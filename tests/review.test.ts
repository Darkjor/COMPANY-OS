import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseVerdict, reviewOf } from "../src/core/review.ts";
import { transition, type HookRecord } from "../src/core/hooks.ts";

const vault = mkdtempSync(join(tmpdir(), "cos-review-"));
const put = (rel: string, text: string) => {
  mkdirSync(join(vault, rel, ".."), { recursive: true });
  writeFileSync(join(vault, rel), text);
};
const R = "Proyectos/demo/research/2026-10-01-x";
const D = "Proyectos/demo/direccion/2026-10-01-rev";
put(`${D}/revision.md`, "# Revisión\n\n## 1. Veredicto: APROBADO CON CORRECCIONES\n");
put(`${R}/informe.md`, `# Informe\n\n- Revisión: \`${D}/revision.md\`\n`);

describe("review verdict read from the documents (QA M1/m4)", () => {
  it("parses the verdict words", () => {
    expect(parseVerdict("Aprobado con correcciones")).toBe("con-correcciones");
    expect(parseVerdict("RECHAZADO")).toBe("rechazado");
    expect(parseVerdict("sin revisar")).toBe("sin-revisar");
    expect(parseVerdict("Aprobado")).toBe("aprobado");
  });

  it("para-direccion: its own 'Revisión de calidad' line, never assumed", () => {
    const pd = (line: string) => reviewOf(vault, `${R}/para-direccion.md`, "para-direccion", `# P\n\n${line}\n\n## Resumen\n`);
    expect(pd("- Revisión de calidad: veredicto Rechazado").review).toBe("rechazado");
    expect(pd("- Revisión de calidad: Aprobado con correcciones").review).toBe("con-correcciones");
    expect(pd("- Revisión de calidad: sin revisar").review).toBe("sin-revisar");
    expect(pd("- Fecha: 2026-10-01").review).toBe("sin-revisar");
    expect(pd(`- Revisión de calidad: \`${D}/revision.md\`, Aprobado`)).toEqual({ review: "aprobado", reviewPath: `${D}/revision.md` });
  });

  it("informe: the cited review decides, and a revision-seguimiento.md wins", () => {
    const head = `# Informe\n\n- Revisión: \`${D}/revision.md\`\n`;
    expect(reviewOf(vault, `${R}/informe.md`, "informe", head)).toEqual({ review: "con-correcciones", reviewPath: `${D}/revision.md` });
    put(`${D}/revision-seguimiento.md`, "# Seguimiento\n\n## 1. Veredicto final: APROBADO\n");
    expect(reviewOf(vault, `${R}/informe.md`, "informe", head)).toEqual({ review: "aprobado", reviewPath: `${D}/revision-seguimiento.md` });
    expect(reviewOf(vault, `${R}/otro.md`, "informe", "# Sin revisión\n")).toEqual({ review: "sin-revisar", reviewPath: null });
    expect(reviewOf(vault, `${D}/revision.md`, "revision", null)).toEqual({ review: null, reviewPath: null });
  });
});

describe("headless sessions keep 'entregó' after SessionEnd (QA M2)", () => {
  const rec = (event: string): HookRecord => ({
    event, sessionId: "s", cwd: null, toolName: null, filePath: null, notificationType: null,
    agentId: null, agentType: null, teamName: null, teammateName: null, taskId: null, payloadKeys: null,
  });
  it("Stop then SessionEnd with a deliverable stays waiting/delivered; without one it ends", () => {
    expect(transition(rec("SessionEnd"), { state: "waiting", reason: "delivered", event: "Stop" }, true)).toEqual({ state: "waiting", reason: "delivered" });
    expect(transition(rec("SessionEnd"), { state: "waiting", reason: "finished", event: "Stop" }, false)).toEqual({ state: "idle", reason: "ended" });
    // A repeated SessionEnd must not renew the 48 h window.
    expect(transition(rec("SessionEnd"), { state: "waiting", reason: "delivered", event: "SessionEnd" }, true)).toBeNull();
  });
});
