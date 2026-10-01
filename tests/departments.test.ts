import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifySession, loadDepartments, matchDepartment } from "../src/core/departments.ts";
import { readVaultText } from "../src/core/vault.ts";

const depts = loadDepartments("Z:/no-existe");

describe("departments", () => {
  it("has the five built-in departments", () => {
    expect(depts.map((d) => d.slug)).toEqual(["direccion", "desarrollo", "diseno", "marketing", "research"]);
  });

  it("matches keywords accent-insensitively and by whole word", () => {
    expect(matchDepartment("Auditoría GA4 y GTM revore.mx", depts)).toBe("marketing");
    expect(matchDepartment("Rediseño de la UI", depts)).toBe("diseno");
    expect(matchDepartment("Análisis de viabilidad inmobiliaria", depts)).toBe("research");
    expect(matchDepartment("Building", depts)).toBeNull(); // "ui" must not match inside a word
  });

  it("prefers the vault department folder over keywords", () => {
    const cwd = "C:\\Users\\P\\COMPANY OS\\Proyectos\\cumbre-real\\marketing\\2026-09-30-carrusel";
    expect(classifySession(cwd, "Análisis de competencia", "C:\\Users\\P\\COMPANY OS", depts)).toBe("marketing");
  });

  it("falls back to desarrollo", () => {
    expect(classifySession("C:\\Projects\\x", "Sesión cualquiera", "C:\\V", depts)).toBe("desarrollo");
  });

  it("vault overrides keywords and adds new departments", () => {
    const v = mkdtempSync(join(tmpdir(), "cos-"));
    mkdirSync(join(v, "_empresa", "departamentos"), { recursive: true });
    writeFileSync(join(v, "_empresa", "departamentos", "ventas.md"), "# Ventas\n\nicono: 💰\npalabras: venta, cliente, crm\n");
    const all = loadDepartments(v);
    expect(all.find((d) => d.slug === "ventas")).toMatchObject({ name: "Ventas", icon: "💰" });
    expect(matchDepartment("Seguimiento CRM del cliente", all)).toBe("ventas");
  });
});

describe("readVaultText", () => {
  it("refuses path traversal and non-text files", () => {
    const v = mkdtempSync(join(tmpdir(), "cos-"));
    writeFileSync(join(v, "nota.md"), "hola");
    writeFileSync(join(v, "foto.png"), "x");
    expect(readVaultText(v, "nota.md")?.content).toBe("hola");
    expect(readVaultText(v, "foto.png")).toBeNull();
    expect(readVaultText(v, "../../../Windows/win.ini")).toBeNull();
    expect(readVaultText(v, "../secret.md")).toBeNull();
  });
});
