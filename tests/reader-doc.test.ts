import { describe, expect, it } from "vitest";
import { classifyHref, hasPendingDecision, isDecideHeading, parseDoc, resolveRelative, splitSections, typeFromName } from "../web/src/readerDoc.ts";
import { compareCalls, isNewDeliverable, signalOf, type CallLike } from "../web/src/signals.ts";
import type { Deliverable, SessionView } from "../web/src/api.ts";

const PD = `# Panorama — para dirección

> guía

- Fecha: 2026-10-01
- Proyecto: company-os
- Entregable completo: \`Proyectos/company-os/research/x/informe.md\`
- Revisión de calidad: \`Proyectos/company-os/direccion/y/revision.md\` — veredicto: Aprobado con correcciones

## La respuesta corta

**Pregunta:** algo

## Qué se pide decidir

- [ ] Decidir A
- [x] Decidir B
`;

describe("parseDoc", () => {
  it("strips the H1 suffix and the metadata bullets of a para-direccion", () => {
    const d = parseDoc(PD, "para-direccion");
    expect(d.title).toBe("Panorama");
    expect(d.date).toBe("2026-10-01");
    expect(d.fullPath).toBe("Proyectos/company-os/research/x/informe.md");
    expect(d.reviewPath).toBe("Proyectos/company-os/direccion/y/revision.md");
    expect(d.verdict).toBe("con-correcciones");
    expect(d.body).not.toMatch(/Entregable completo/);
    expect(d.body).not.toMatch(/^# /m);
    expect(d.body).toMatch(/## La respuesta corta/);
  });
  it("keeps the header bullets of a full report as written", () => {
    const d = parseDoc("# Informe\n\n- Fecha: 2026-10-01\n- Autor: x\n\n## 1. A\n", "informe");
    expect(d.title).toBe("Informe");
    expect(d.body).toMatch(/Fecha: 2026-10-01/);
  });
  it("ignores a # inside a code fence", () => {
    expect(parseDoc("```\n# no\n```\n", "otro").title).toBeNull();
  });
});

describe("sections and decisions", () => {
  it("splits by H2 outside fences and detects pending boxes", () => {
    const s = splitSections("intro\n## A\n```\n## no\n```\n## Qué se pide decidir\n- [ ] x\n");
    expect(s.map((x) => x.heading)).toEqual(["", "A", "Qué se pide decidir"]);
    expect(isDecideHeading(s[2].heading)).toBe(true);
    expect(hasPendingDecision(s[2].md)).toBe(true);
    expect(hasPendingDecision("- [x] hecho\n")).toBe(false);
  });
});

describe("links", () => {
  it("only http(s) and in-vault documents become links", () => {
    expect(classifyHref("https://a.com")).toBe("external");
    expect(classifyHref("javascript:alert(1)")).toBe("none");
    expect(classifyHref("JaVaScRiPt:alert(1)")).toBe("none");
    expect(classifyHref("data:text/html,x")).toBe("none");
    expect(classifyHref("//evil.com/x.md")).toBe("none");
    expect(classifyHref("../otro/informe.md")).toBe("internal");
    expect(classifyHref("#ancla")).toBe("none");
  });
  it("resolves relative paths and refuses to escape the vault", () => {
    expect(resolveRelative("Proyectos/a/b/c/x.md", "../d/y.md")).toBe("Proyectos/a/b/d/y.md");
    expect(resolveRelative("a/x.md", "../../y.md")).toBeNull();
  });
  it("types by file name", () => {
    expect(typeFromName("para-direccion.md")).toBe("para-direccion");
    expect(typeFromName("notas.md")).toBe("otro");
  });
});

const sess = (o: Partial<SessionView>): SessionView => ({ id: "s", status: "waiting", lastEventAt: "2026-10-01T10:00:00Z", ...o }) as SessionView;
const del = (o: Partial<Deliverable> = {}): Deliverable =>
  ({ path: "Proyectos/p/d/f/informe.md", at: "2026-10-01T10:00:00Z", seenAt: null, type: "informe", ...o }) as Deliverable;

describe("signals", () => {
  it("delivered drops to finished once seen, and returns if rewritten later", () => {
    const d = del();
    const s = sess({ waitingKind: "delivered", deliverable: d });
    expect(signalOf(s)).toBe("delivered");
    expect(signalOf(s, (p) => p === d.path)).toBe("finished");
    expect(signalOf(sess({ waitingKind: "delivered", deliverable: del({ seenAt: "2026-10-01T10:05:00Z" }) }))).toBe("finished");
    expect(isNewDeliverable(del({ seenAt: "2026-10-01T09:00:00Z" }), () => false)).toBe(true);
  });
  it("maps error, permission, question and plain waiting", () => {
    expect(signalOf(sess({ status: "error" }))).toBe("error");
    expect(signalOf(sess({ waitingKind: "permission" }))).toBe("permission");
    expect(signalOf(sess({ waitingKind: "question" }))).toBe("question");
    expect(signalOf(sess({ status: "working" }))).toBeNull();
  });
  it("orders error > permission > question > delivered > finished, ties by longest wait", () => {
    const mk = (signal: CallLike["signal"], at: string): CallLike => ({ signal, s: sess({ lastEventAt: at }) });
    const calls = [mk("finished", "1"), mk("delivered", "2"), mk("question", "3"), mk("permission", "9"), mk("permission", "4"), mk("error", "5")];
    expect(calls.sort(compareCalls).map((c) => `${c.signal}${c.s.lastEventAt}`)).toEqual(["error5", "permission4", "permission9", "question3", "delivered2", "finished1"]);
  });
});
