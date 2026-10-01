import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "./db.ts";
import { freshHookState, hookStates } from "./hooks.ts";
import type { AgentView, Status } from "./queries.ts";

/**
 * Claude Code agent teams: `~/.claude/teams/<team>/config.json` lists the lead's session and the
 * teammates. The config also holds each teammate's full spawn prompt, so only the allow-listed
 * fields below are ever read out of it: the prompt never reaches the DB, the API or the logs.
 * Approach based on the claudeTeamProvider of pixel-agents (MIT).
 *
 * Copyright (c) 2025 Pablo De Lucca. MIT License (https://github.com/pablodelucca/pixel-agents)
 */

export interface TeamMemberConfig {
  agentId: string | null;
  name: string;
  agentType: string | null;
  model: string | null;
  /** `isActive:false` = the CLI marked this one-shot teammate finished; missing = active. */
  isActive: boolean | null;
}

export interface TeamConfig {
  /** Folder name under ~/.claude/teams. */
  id: string;
  name: string;
  description: string | null;
  leadSessionId: string;
  leadAgentId: string | null;
  members: TeamMemberConfig[];
}

export type WaitingKind = "permission" | "question" | "finished" | "delivered";

export interface TeamMemberView {
  name: string;
  /** HAT name when the teammate wears one of the company's HATs; else null. */
  hat: string | null;
  department: string | null;
  status: Status;
  waitingKind: WaitingKind | null;
  model: string | null;
  current: string | null;
  /** Only when the teammate runs as its own session (not inside the lead's). */
  sessionId?: string;
}

export interface TeamView {
  id: string;
  name: string;
  description: string | null;
  leaderSessionId: string;
  members: TeamMemberView[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length > 0 && !v.includes("\u0000") ? v.slice(0, max) : null;
const SESSION_RE = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_MEMBERS = 50;

/** Parse one config.json defensively. Null when it is not a usable team. */
export function parseTeamConfig(id: string, raw: unknown): TeamConfig | null {
  if (!isObj(raw)) return null;
  const leadSessionId = text(raw.leadSessionId, 100);
  if (!leadSessionId || !SESSION_RE.test(leadSessionId)) return null;
  const members: TeamMemberConfig[] = [];
  if (Array.isArray(raw.members)) {
    for (const m of raw.members.slice(0, MAX_MEMBERS)) {
      if (!isObj(m)) continue;
      const name = text(m.name, 200);
      if (!name) continue;
      members.push({
        agentId: text(m.agentId, 300),
        name,
        agentType: text(m.agentType, 100),
        model: text(m.model, 100),
        isActive: typeof m.isActive === "boolean" ? m.isActive : null,
      });
    }
  }
  return {
    id,
    name: text(raw.name, 200) ?? id,
    description: text(raw.description, 300),
    leadSessionId,
    leadAgentId: text(raw.leadAgentId, 300),
    members,
  };
}

/** Read every team config under `dir` (missing dir, bad JSON or odd shapes are skipped). */
export function loadTeams(dir: string): TeamConfig[] {
  if (!existsSync(dir)) return [];
  const out: TeamConfig[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const id of names.slice(0, 200)) {
    if (id.startsWith(".") || id.length > 200) continue;
    const file = join(dir, id, "config.json");
    try {
      const st = statSync(file);
      if (!st.isFile() || st.size > 5 * 1024 * 1024) continue;
      const team = parseTeamConfig(id, JSON.parse(readFileSync(file, "utf8")));
      if (team) out.push(team);
    } catch {
      /* unreadable or dissolved team: ignore */
    }
  }
  return out;
}

const WAITING: ReadonlySet<string> = new Set(["permission", "question", "finished", "delivered"]);
const waitingOf = (k: string | null): WaitingKind | null => (k && WAITING.has(k) ? (k as WaitingKind) : null);

interface HookLink {
  agentIds: Set<string>;
  sessionIds: Set<string>;
}

/** What the hooks saw of each teammate (TeammateIdle / TaskCreated / ... carry team + teammate names). */
function hookLinks(db: DB, teamName: string): Map<string, HookLink> {
  const rows = db
    .prepare(
      `SELECT DISTINCT teammate_name n, agent_id a, session_id s FROM hook_events
       WHERE team_name = ? AND teammate_name IS NOT NULL LIMIT 500`,
    )
    .all(teamName) as { n: string; a: string | null; s: string }[];
  const map = new Map<string, HookLink>();
  for (const r of rows) {
    const l = map.get(r.n) ?? { agentIds: new Set<string>(), sessionIds: new Set<string>() };
    if (r.a) l.agentIds.add(r.a);
    l.sessionIds.add(r.s);
    map.set(r.n, l);
  }
  return map;
}

/**
 * The `team` of a lead session. Teammates are tied to what we observe, in this order: a subagent
 * whose id a hook attributed to the teammate, a subagent named like the teammate (sidecar
 * `name`), the teammate's own session (hooks from another session with the same team + name);
 * otherwise the config alone says whether it is still around (`isActive:false` means done).
 */
export function buildTeam(
  db: DB,
  team: TeamConfig,
  leadSessionId: string,
  agents: AgentView[],
  hats: Map<string, string>,
  now: number,
): TeamView {
  const links = hookLinks(db, team.name);
  const subs = agents.filter((a) => a.kind === "subagent");
  const rawId = (a: AgentView) => a.id.slice(leadSessionId.length + 1).replace(/^agent-/, "");
  const members = team.members
    .filter((m) => m.agentId === null || m.agentId !== team.leadAgentId)
    .map((m): TeamMemberView => {
      const link = links.get(m.name);
      const linked = subs.find((a) => link?.agentIds.has(rawId(a))) ?? subs.find((a) => a.name === m.name);
      const hat = [m.agentType, linked?.agentType].find((h): h is string => !!h && hats.has(h)) ?? null;
      const own = [...(link?.sessionIds ?? [])].find((s) => s !== leadSessionId);
      const base = { name: m.name, hat, department: hat ? hats.get(hat) ?? null : null };
      const sid = own ? { sessionId: own } : {};
      if (linked) {
        return {
          ...base, status: linked.status, waitingKind: waitingOf(linked.waitingKind),
          model: linked.model ?? m.model, current: linked.current, ...sid,
        };
      }
      if (own) {
        const h = freshHookState(hookStates(db, own).get(""), null, now);
        if (h) {
          return {
            ...base, status: h.state, waitingKind: h.state === "waiting" ? waitingOf(h.reason) : null,
            model: m.model, current: null, ...sid,
          };
        }
      }
      return { ...base, status: m.isActive === false ? "done" : "idle", waitingKind: null, model: m.model, current: null, ...sid };
    });
  return { id: team.id, name: team.name, description: team.description, leaderSessionId: leadSessionId, members };
}
