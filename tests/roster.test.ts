import { describe, expect, it } from "vitest";
import { rosterOf, type AgentView } from "../src/core/queries.ts";

const NOW = Date.parse("2026-10-01T18:00:00Z");
const agent = (id: string, o: Partial<AgentView>): AgentView => ({
  id, kind: "subagent", agentType: "general-purpose", name: null, description: null, model: null, parentId: "main",
  spawnDepth: 1, status: "done", current: null, lastEventAt: "2026-10-01T17:50:00Z", tokens: {} as AgentView["tokens"],
  hatDepartment: null, waitingKind: null, source: "transcript", ...o,
});
const at = (min: number) => new Date(NOW - min * 60_000).toISOString();

describe("seat roster", () => {
  it("puts active agents first, then the most recent finished; a stale error does not outrank them", () => {
    const { roster } = rosterOf([
      agent("old-error", { status: "error", lastEventAt: at(90) }),
      agent("done-1", { lastEventAt: at(10) }),
      agent("done-2", { lastEventAt: at(5) }),
      agent("asks", { status: "waiting", waitingKind: "question", lastEventAt: at(30) }),
      agent("works", { status: "working", lastEventAt: at(1) }),
    ], NOW);
    expect(roster.map((a) => a.id)).toEqual(["works", "asks", "done-2", "done-1", "old-error"]);
  });

  it("caps at 6, counts every eligible agent, and drops finished ones older than 2 h", () => {
    const subs = [
      ...Array.from({ length: 8 }, (_, i) => agent(`d${i}`, { lastEventAt: at(i + 1) })),
      agent("ancient", { lastEventAt: at(200) }),
    ];
    const { roster, subagents } = rosterOf(subs, NOW);
    expect(roster).toHaveLength(6);
    expect(subagents).toBe(8);
    expect(roster.some((a) => a.id === "ancient")).toBe(false);
  });

  it("labels by HAT, else name, else description, else agent type", () => {
    const { roster } = rosterOf([
      agent("h", { agentType: "dev-backend", hatDepartment: "desarrollo", name: "x", lastEventAt: at(1) }),
      agent("n", { name: "Revisor A", description: "revisa", lastEventAt: at(2) }),
      agent("d", { description: "busca precios", lastEventAt: at(3) }),
      agent("t", { agentType: "Explore", lastEventAt: at(4) }),
    ], NOW);
    expect(roster.map((a) => [a.label, a.hat])).toEqual([
      ["dev-backend", "dev-backend"], ["Revisor A", null], ["busca precios", null], ["Explore", null],
    ]);
  });
});
