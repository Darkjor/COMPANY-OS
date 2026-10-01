import { useEffect, useRef, useState } from "react";

export type Status = "working" | "waiting" | "subagents" | "error" | "idle" | "done";

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface SessionView {
  id: string;
  title: string | null;
  cwd: string | null;
  gitBranch: string | null;
  model: string | null;
  startedAt: string | null;
  lastEventAt: string | null;
  status: Status;
  current: string | null;
  tokens: Tokens;
  activeAgents: number;
  department: string;
  automated: boolean;
  hat: { name: string; department: string } | null;
  crew: CrewMember[];
  drones: number;
  /** Only with status "waiting". Absent on servers that predate hooks. */
  waitingKind?: WaitingKind | null;
  deliverable?: Deliverable | null;
  /** Only on a session that leads a team (members exclude the leader). */
  team?: TeamView | null;
}

export interface TeamMember {
  name: string;
  hat: string | null;
  department: string | null;
  status: Status;
  waitingKind: WaitingKind | null;
  model: string | null;
  current: string | null;
  /** Present when the teammate runs in a session of its own. */
  sessionId?: string;
}

export interface TeamView {
  id: string;
  name: string;
  description?: string | null;
  leaderSessionId: string;
  members: TeamMember[];
}

export type WaitingKind = "permission" | "question" | "finished" | "delivered";
export type DeliverableType = "para-direccion" | "informe" | "revision" | "plan" | "brief" | "otro";
export type ReviewVerdict = "aprobado" | "con-correcciones" | "rechazado" | "sin-revisar";

export interface Deliverable {
  /** Vault-relative, "/"-separated. */
  path: string;
  type: DeliverableType;
  title: string;
  at: string;
  hat: string | null;
  /** Real verdict computed by the backend (para-direccion/informe/plan); null for the rest. */
  review: ReviewVerdict | null;
  /** The review that decides; null when none. `undefined` only on servers that predate the field. */
  reviewPath?: string | null;
  name: string;
  project: string;
  department: string;
  sessionId: string | null;
  createdAt: string;
  seenAt: string | null;
}

export interface CrewMember {
  id: string;
  hat: string;
  department: string;
  status: Status;
  model: string | null;
  current: string | null;
}

export interface DeptSummary {
  slug: string;
  name: string;
  icon: string;
  status: Status;
  activeAgents: number;
  sessions: number;
}

export interface ProjectView {
  key: string;
  name: string;
  mapped: boolean;
  slug: string | null;
  status: Status;
  lastEventAt: string | null;
  tokensToday: Tokens;
  sessions: SessionView[];
  departments: DeptSummary[];
}

export interface VaultEntry {
  path: string;
  name: string;
  kind: "file" | "dir";
  mtime: string;
  size: number;
  children?: VaultEntry[];
}

export interface DepartmentDetail extends DeptSummary {
  sessionList: SessionView[];
  files: VaultEntry[];
}

export interface ProjectDetail {
  project: Omit<ProjectView, "sessions">;
  departments: DepartmentDetail[];
  vaultDir: string | null;
}

export const projectHref = (key: string) => `#/p/${encodeURIComponent(key)}`;

export interface Overview {
  generatedAt: string;
  tokensToday: Tokens;
  projects: ProjectView[];
}

export interface AgentView {
  id: string;
  kind: "main" | "subagent";
  agentType: string | null;
  name: string | null;
  description: string | null;
  model: string | null;
  parentId: string | null;
  spawnDepth: number;
  status: Status;
  current: string | null;
  lastEventAt: string | null;
  tokens: Tokens;
  hatDepartment: string | null;
  /** Backend 1d: absent on servers that predate it. */
  performance?: AgentPerformance;
}

export interface AgentPerformance {
  /** EXACT, from Claude Code's notification; null for the main agent and foreground agents. */
  reportedTokens: number | null;
  newContext: number;
  cacheRead: number;
  /** APPROXIMATE and undercounted. */
  outputApprox: number;
  toolCalls: number;
  toolCap: number | null;
  durationMs: number | null;
  deliverables: { path: string; type: string; title: string; at: string }[];
}

export interface EventRow {
  id: string;
  agentId: string;
  ts: string;
  kind: string;
  toolName: string | null;
  summary: string;
}

export interface SessionDetail {
  session: SessionView;
  project: { key: string; name: string; mapped: boolean; slug: string | null };
  agents: AgentView[];
  events: EventRow[];
  files: { path: string; op: string; n: number; lastTs: string }[];
  performance?: AgentPerformance;
  deliverables?: Deliverable[];
}

/** Fetch JSON and refetch on every SSE "changed" event (throttled) plus a slow tick for status aging. */
export function useLive<T>(url: string | null): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!url) return;
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as T;
        if (alive) {
          setData(json);
          setError(null);
        }
      } catch (err) {
        if (alive) setError(String(err));
      }
    };
    const schedule = () => {
      if (timer.current !== null) return;
      timer.current = window.setTimeout(() => {
        timer.current = null;
        void load();
      }, 400);
    };
    void load();
    const es = new EventSource("/api/stream");
    es.addEventListener("changed", schedule);
    const tick = window.setInterval(schedule, 15_000);
    return () => {
      alive = false;
      es.close();
      window.clearInterval(tick);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [url]);

  return { data, error };
}

export function useNow(intervalMs = 5000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

export const deliverableHref = (path: string, fromReady = false) =>
  `#/d/${encodeURIComponent(path)}${fromReady ? "?from=ready" : ""}`;

/* "Visto" lives in the backend; this module-level set only makes the UI react before the SSE refetch lands. */
const locallySeen = new Set<string>();
const seenListeners = new Set<() => void>();
let seenVersion = 0;

export function isLocallySeen(path: string): boolean {
  return locallySeen.has(path);
}

/** Re-renders the caller whenever something is marked seen. */
export function useSeenVersion(): number {
  const [, setV] = useState(0);
  useEffect(() => {
    const on = () => setV((v) => v + 1);
    seenListeners.add(on);
    return () => void seenListeners.delete(on);
  }, []);
  return seenVersion;
}

export async function markSeen(path: string): Promise<void> {
  locallySeen.add(path);
  seenVersion++;
  seenListeners.forEach((fn) => fn());
  try {
    const res = await fetch("/api/deliverables/seen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    // 404 = not a known deliverable: nothing to persist, keep the local mark for this tab.
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
  } catch {
    // Offline or server down: the local mark still dismisses it in this tab.
  }
}

/** A session link; `member` makes the session screen focus that teammate. */
export const sessionHref = (id: string, member?: string | null) =>
  `#/s/${encodeURIComponent(id)}${member ? `?m=${encodeURIComponent(member)}` : ""}`;
