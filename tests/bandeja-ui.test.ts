import { describe, expect, it } from "vitest";
import type { CrewMember, SessionView, TeamMember, TeamView } from "../web/src/api.ts";
import { fmtDuration, fmtInt, fmtK, isOverCap, tokenCell, totalTokenCell } from "../web/src/perf.ts";
import { signalOf } from "../web/src/signals.ts";
import { citedReviewPath, followUpOf, reviewCandidate, reviewVerdictFromDoc } from "../web/src/readerDoc.ts";
import { crewCoveredByMembers, memberBlocking, memberGlyph, roomTeams, seatedMembers, teamAlive } from "../web/src/teams.ts";

const member = (over: Partial<TeamMember> = {}): TeamMember => ({
  name: "m",
  hat: "copywriter",
  department: "marketing",
  status: "working",
  waitingKind: null,
  model: null,
  current: null,
  ...over,
});

const team = (members: TeamMember[], name = "equipo"): TeamView => ({ id: name, name, leaderSessionId: "L", members });

const session = (id: string, startedAt: string, t: TeamView | null, crew: CrewMember[] = []): SessionView =>
  ({ id, startedAt, team: t, crew }) as unknown as SessionView;

describe("equipos (spec §4)", () => {
  it("un equipo con todos los miembros terminados no está vivo", () => {
    expect(teamAlive(team([member({ status: "done" }), member({ name: "b", status: "done" })]))).toBe(false);
    expect(teamAlive(team([member({ status: "done" }), member({ name: "b", status: "idle" })]))).toBe(true);
  });

  it("asigna letras por orden de inicio del líder y solo a equipos vivos", () => {
    const sessions = [
      session("s3", "2026-10-01T12:00:00Z", team([member()], "tercero")),
      session("s0", "2026-10-01T09:00:00Z", null),
      session("s1", "2026-10-01T10:00:00Z", team([member({ status: "done" })], "muerto")),
      session("s2", "2026-10-01T11:00:00Z", team([member()], "segundo")),
    ];
    const infos = roomTeams(sessions);
    expect(infos.map((i) => [i.letter, i.team.name])).toEqual([
      ["A", "segundo"],
      ["B", "tercero"],
    ]);
  });

  it("un compañero con sesión propia en la sala no se dibuja dos veces", () => {
    const lead = session("L", "2026-10-01T09:00:00Z", team([member({ name: "x", sessionId: "own" }), member({ name: "y" })]));
    const [info] = roomTeams([lead]);
    expect(seatedMembers(info, new Set(["L", "own"])).map((m) => m.name)).toEqual(["y"]);
    expect(seatedMembers(info, new Set(["L"])).map((m) => m.name)).toEqual(["x", "y"]);
  });

  it("el subagente que representa a un compañero no se repite", () => {
    const crew = [
      { id: "L/1", hat: "copywriter", department: "marketing" },
      { id: "L/2", hat: "copywriter", department: "marketing" },
    ] as CrewMember[];
    const lead = session("L", "2026-10-01T09:00:00Z", team([member({ name: "copy" })]), crew);
    const covered = crewCoveredByMembers(roomTeams([lead]), new Set(["L"]));
    expect([...covered]).toEqual(["L/1"]);
  });

  it("glifos y bloqueo por estado", () => {
    expect(memberGlyph({ status: "working", waitingKind: null })).toBe("*");
    expect(memberGlyph({ status: "idle", waitingKind: null })).toBe(".");
    expect(memberGlyph({ status: "waiting", waitingKind: "permission" })).toBe("!");
    expect(memberGlyph({ status: "waiting", waitingKind: "question" })).toBe("?");
    expect(memberBlocking({ status: "waiting", waitingKind: "delivered" })).toBeNull();
    expect(memberBlocking({ status: "waiting", waitingKind: "question" })).toBe("question");
    expect(memberBlocking({ status: "error", waitingKind: null })).toBe("error");
  });
});

describe("desempeño (formato)", () => {
  it("tokens en k con un decimal, separador de miles en enteros", () => {
    expect(fmtK(189341)).toBe("189.3k");
    expect(fmtK(901424)).toBe("901.4k");
    expect(fmtK(1_142_595)).toBe("1,142.6k");
    expect(fmtK(40)).toBe("40");
    expect(fmtInt(46218553)).toBe("46,218,553");
  });

  it("duración legible", () => {
    expect(fmtDuration(null)).toBe("—");
    expect(fmtDuration(45_000)).toBe("45 s");
    expect(fmtDuration(638_568)).toBe("10 min 39 s");
    expect(fmtDuration(4_460_733)).toBe("1 h 14 min");
  });

  it("tokens exactos si Claude Code los reportó; si no, aproximados con ≈", () => {
    const exact = tokenCell({ reportedTokens: 189341, newContext: 187259, outputApprox: 627 });
    expect(exact).toMatchObject({ text: "189.3k", approx: false });
    const approx = tokenCell({ reportedTokens: null, newContext: 100_000, outputApprox: 2_300 });
    expect(approx.approx).toBe(true);
    expect(approx.text).toBe("≈ 102.3k");
    expect(approx.title).toMatch(/aproximado/i);
  });

  it("por encima del tope solo con tope definido", () => {
    expect(isOverCap({ toolCalls: 70, toolCap: 40 })).toBe(true);
    expect(isOverCap({ toolCalls: 40, toolCap: 40 })).toBe(false);
    expect(isOverCap({ toolCalls: 400, toolCap: null })).toBe(false);
  });
});

describe("revisión de un informe", () => {
  const informe = `# Panorama competitivo

- Fecha del informe: 2026-10-01
- Versión: v2, corregida tras la revisión (\`Proyectos/company-os/direccion/2026-10-01-revision-x/revision.md\`, veredicto "Aprobado con correcciones").

---

## 1. Preguntas
`;

  it("encuentra la ruta citada en las primeras líneas", () => {
    expect(citedReviewPath(informe)).toBe("Proyectos/company-os/direccion/2026-10-01-revision-x/revision.md");
    expect(citedReviewPath("# T\n\nsin nada")).toBeNull();
    // Lejos de las primeras líneas ya no cuenta.
    expect(citedReviewPath("x\n".repeat(20) + "`Proyectos/a/b/revision.md`")).toBeNull();
  });

  it("una revision*.md de la misma carpeta gana a la citada; el seguimiento gana a la revisión", () => {
    const doc = "Proyectos/p/research/e/informe.md";
    expect(reviewCandidate(doc, informe, ["Proyectos/p/research/e/revision.md"])).toBe("Proyectos/p/research/e/revision.md");
    expect(reviewCandidate(doc, informe, ["Proyectos/p/research/e/revision.md", "Proyectos/p/research/e/revision-seguimiento.md"])).toBe(
      "Proyectos/p/research/e/revision-seguimiento.md",
    );
    expect(reviewCandidate(doc, informe, ["Proyectos/p/otra/revision.md"])).toBe("Proyectos/company-os/direccion/2026-10-01-revision-x/revision.md");
    expect(followUpOf("Proyectos/a/b/c/revision.md")).toBe("Proyectos/a/b/c/revision-seguimiento.md");
  });

  it("lee el veredicto del encabezado", () => {
    expect(reviewVerdictFromDoc("# R\n\n## 1. Veredicto: APROBADO CON CORRECCIONES\n")).toBe("con-correcciones");
    expect(reviewVerdictFromDoc("# R\n\n## 1. Veredicto final: APROBADO\n")).toBe("aprobado");
    expect(reviewVerdictFromDoc("## 2. Veredicto: RECHAZADO")).toBe("rechazado");
    expect(reviewVerdictFromDoc("# R\n\n```\n## 1. Veredicto: APROBADO\n```\n")).toBeNull();
    expect(reviewVerdictFromDoc("# R\n\nsin veredicto")).toBeNull();
  });
});

describe("correcciones del QA (3c)", () => {
  const del = { path: "Proyectos/p/research/x/para-direccion.md", at: "2026-10-01T10:00:00Z", seenAt: null } as never;
  const sess = (over: Record<string, unknown>) => ({ status: "waiting", waitingKind: "delivered", deliverable: del, ...over }) as unknown as SessionView;

  it("una sesión terminada con informe sin ver sigue como 'informe listo' y, vista, deja de pedirse", () => {
    expect(signalOf(sess({}))).toBe("delivered");
    expect(signalOf(sess({ status: "done" }))).toBe("delivered");
    expect(signalOf(sess({ status: "idle" }))).toBe("delivered");
    expect(signalOf(sess({ status: "done" }), () => true)).toBeNull();
    expect(signalOf(sess({}), () => true)).toBe("finished");
    expect(signalOf(sess({ status: "working" }))).toBeNull();
  });

  it("el total mezcla exactos y aproximados y lo dice con ≈", () => {
    const exact = { reportedTokens: 900_000, newContext: 0, outputApprox: 0 };
    const main = { reportedTokens: null, newContext: 400_000, outputApprox: 40_000 };
    const t = totalTokenCell([exact, main]);
    expect(t.approx).toBe(true);
    expect(t.text).toBe("≈ 1,340.0k");
    expect(t.title).toContain("Incluye cifras aproximadas");
    expect(totalTokenCell([exact, { ...exact, reportedTokens: 100_000 }])).toMatchObject({ approx: false, text: "1,000.0k" });
  });
});
