import type { CrewMember, SessionView, TeamMember, TeamView } from "./api.ts";

/** Pure team helpers (no React) so they can be tested from tests/. Spec §4. */

export interface TeamInfo {
  /** A, B, C… by the order the leaders started inside one room. */
  letter: string;
  team: TeamView;
  leader: SessionView;
}

/** "Equipo vivo" = some member is not finished; an old config with everyone done paints nothing. */
export const teamAlive = (team: TeamView) => team.members.some((m) => m.status !== "done");

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Live teams of one room, lettered by leader start. Letters restart in every room. */
export function roomTeams(sessions: SessionView[]): TeamInfo[] {
  return sessions
    .filter((s): s is SessionView & { team: TeamView } => !!s.team && teamAlive(s.team))
    .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || a.id.localeCompare(b.id))
    .map((leader, i) => ({ letter: LETTERS[i % LETTERS.length], team: leader.team, leader }));
}

/** Members that need a seat of their own: not finished, and not already drawn as a session of the room. */
export function seatedMembers(info: TeamInfo, roomSessionIds: ReadonlySet<string>): TeamMember[] {
  return info.team.members.filter((m) => m.status !== "done" && !(m.sessionId && roomSessionIds.has(m.sessionId)));
}

/**
 * A teammate bound to a subagent also shows up in `leader.crew`; draw it once.
 * Returns the ids of crew entries that a member seat already stands for.
 */
export function crewCoveredByMembers(infos: TeamInfo[], roomSessionIds: ReadonlySet<string>): Set<string> {
  const covered = new Set<string>();
  for (const info of infos) {
    for (const m of seatedMembers(info, roomSessionIds)) {
      if (m.sessionId || !m.hat) continue;
      const twin = info.leader.crew.find((c: CrewMember) => c.hat === m.hat && !covered.has(c.id));
      if (twin) covered.add(twin.id);
    }
  }
  return covered;
}

/** Status glyph for a strip chip: always a shape, never colour alone. */
export function memberGlyph(m: Pick<TeamMember, "status" | "waitingKind">): string {
  if (m.status === "error") return "✕";
  if (m.status === "waiting") {
    switch (m.waitingKind) {
      case "permission":
        return "!";
      case "question":
        return "?";
      case "delivered":
        return "▯";
      default:
        return "✓";
    }
  }
  if (m.status === "working" || m.status === "subagents") return "*";
  return ".";
}

/** The signal a waiting teammate is sending, when it is blocked on the human. */
export function memberBlocking(m: Pick<TeamMember, "status" | "waitingKind">): "error" | "permission" | "question" | null {
  if (m.status === "error") return "error";
  if (m.status === "waiting" && (m.waitingKind === "permission" || m.waitingKind === "question")) return m.waitingKind;
  return null;
}

export const MAX_CHIPS = 4;
