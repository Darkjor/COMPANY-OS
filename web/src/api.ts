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
