import { useMemo, useState } from "react";
import { projectHref, useLive, useNow, type AgentView, type EventRow, type SessionDetail } from "./api.ts";
import { Drone, Worker } from "./pixel/Sprites.tsx";
import {
  STATUS_LABEL,
  agentLabel,
  clock,
  fmtNum,
  freshTokens,
  modelLabel,
  modelTier,
  shortPath,
  timeAgo,
} from "./format.ts";

const KIND_GLYPH: Record<string, string> = {
  prompt: "›",
  text: "¶",
  thinking: "…",
  tool_use: "⚙",
  tool_result: "↳",
  error: "✕",
};

export function Session({ id }: { id: string }) {
  const { data, error } = useLive<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`);
  const now = useNow(2000);
  const [focus, setFocus] = useState<string | null>(null);
  const [showResults, setShowResults] = useState(false);

  const tree = useMemo(() => buildTree(data?.agents ?? []), [data]);
  const names = useMemo(() => new Map((data?.agents ?? []).map((a) => [a.id, a])), [data]);

  if (error && !data) return <div className="empty">No se pudo cargar la sesión: {error}</div>;
  if (!data) return <div className="empty">Cargando sesión…</div>;

  const { session: s, project } = data;
  const events = data.events.filter(
    (e) => (!focus || e.agentId === focus) && (showResults || e.kind !== "tool_result"),
  );

  return (
    <>
      <a className="back" href={projectHref(project.key)}>← {project.name}</a>
      <header className="detail-head">
        <Worker seed={s.id} model={s.model} status={s.status === "subagents" ? "working" : s.status} scale={5} />
        <div>
          <div className="crumb">
            {project.name} · {s.department}
            {s.gitBranch ? ` · ${s.gitBranch}` : ""}
          </div>
          <h1>{s.title ?? "Sesión sin título"}</h1>
          <div className="muted">
            {STATUS_LABEL[s.status]} · actividad {timeAgo(s.lastEventAt, now)} · {fmtNum(freshTokens(s.tokens))} tokens
            ({fmtNum(s.tokens.output)} de salida, {fmtNum(s.tokens.cacheRead)} de caché)
          </div>
        </div>
      </header>

      <div className="detail">
        <aside className="panel">
          <h3>Agentes <span className="muted">({data.agents.length})</span></h3>
          <ul className="tree">
            {tree.map(({ agent, depth }) => (
              <li key={agent.id}>
                <button
                  className={`agent ${focus === agent.id ? "agent-focus" : ""}`}
                  style={{ paddingLeft: 10 + depth * 18 }}
                  onClick={() => setFocus(focus === agent.id ? null : agent.id)}
                >
                  {agent.kind === "main" || agent.hatDepartment ? (
                    <Worker
                      seed={agent.kind === "main" ? s.id : agent.id}
                      model={agent.model}
                      status={agent.status === "subagents" ? "working" : agent.status}
                      hat={agent.hatDepartment}
                      scale={2}
                    />
                  ) : (
                    <span className={`avatar avatar-${agent.status}`} title={agent.agentType ?? "subagente"}>
                      <Drone scale={4} />
                    </span>
                  )}
                  <span className="agent-body">
                    <span className="agent-name">
                      {agentLabel(agent)}
                      <span className={`chip chip-${modelTier(agent.model)}`}>{modelLabel(agent.model)}</span>
                    </span>
                    <span className="agent-desc">
                      {agent.status === "working" ? agent.current : agent.description ?? STATUS_LABEL[agent.status]}
                    </span>
                  </span>
                  <span className="agent-tok">{fmtNum(agent.tokens.output)}</span>
                </button>
              </li>
            ))}
          </ul>

          <h3>Archivos tocados</h3>
          {data.files.length === 0 ? (
            <div className="muted small">Ninguno todavía.</div>
          ) : (
            <ul className="files">
              {data.files.slice(0, 30).map((f) => (
                <li key={`${f.path}:${f.op}`} title={f.path}>
                  <span className={`op op-${f.op}`}>{f.op}</span>
                  <span className="mono">{shortPath(f.path)}</span>
                  {f.n > 1 && <span className="muted">×{f.n}</span>}
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="panel timeline">
          <div className="timeline-head">
            <h3>
              Actividad {focus && <span className="muted">· {agentLabel(names.get(focus)!)}</span>}
            </h3>
            <label className="toggle">
              <input type="checkbox" checked={showResults} onChange={(e) => setShowResults(e.target.checked)} />
              mostrar resultados
            </label>
          </div>
          <ol className="events">
            {events.map((e) => (
              <EventItem key={e.id} e={e} agent={names.get(e.agentId)} showAgent={!focus && data.agents.length > 1} />
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}

function EventItem({ e, agent, showAgent }: { e: EventRow; agent?: AgentView; showAgent: boolean }) {
  return (
    <li className={`ev ev-${e.kind}`}>
      <span className="ev-time mono">{clock(e.ts)}</span>
      <span className="ev-glyph">{KIND_GLYPH[e.kind] ?? "·"}</span>
      <span className="ev-text">
        {showAgent && agent && agent.kind === "subagent" && <span className="ev-agent">{agentLabel(agent)}</span>}
        {e.summary}
      </span>
    </li>
  );
}

function buildTree(agents: AgentView[]): { agent: AgentView; depth: number }[] {
  const children = new Map<string | null, AgentView[]>();
  const ids = new Set(agents.map((a) => a.id));
  for (const a of agents) {
    const parent = a.parentId && ids.has(a.parentId) ? a.parentId : a.kind === "main" ? null : agents.find((x) => x.kind === "main")?.id ?? null;
    const list = children.get(parent) ?? [];
    list.push(a);
    children.set(parent, list);
  }
  const out: { agent: AgentView; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const a of children.get(parent) ?? []) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push({ agent: a, depth });
      walk(a.id, depth + 1);
    }
  };
  walk(null, 0);
  for (const a of agents) if (!seen.has(a.id)) out.push({ agent: a, depth: 1 });
  return out;
}
