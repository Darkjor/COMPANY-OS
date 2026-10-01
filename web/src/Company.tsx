import { useState } from "react";
import { projectHref, useLive, useNow, type Overview, type ProjectView, type SessionView } from "./api.ts";
import { DeptStrip } from "./DeptStrip.tsx";
import { STATUS_LABEL, fmtNum, freshTokens, modelLabel, modelTier, timeAgo } from "./format.ts";

const LIVE = new Set(["working", "subagents", "waiting", "error"]);

export function Company() {
  const [days, setDays] = useState(30);
  const { data, error } = useLive<Overview>(`/api/overview?days=${days}`);
  const now = useNow();
  const [onlyLive, setOnlyLive] = useState(false);

  if (error && !data) return <div className="empty">No hay conexión con el observador: {error}</div>;
  if (!data) return <div className="empty">Cargando la empresa…</div>;

  const sessions = data.projects.flatMap((p) => p.sessions);
  const working = sessions.filter((s) => s.status === "working" || s.status === "subagents").length;
  const waiting = sessions.filter((s) => s.status === "waiting").length;
  const agentsNow = sessions.reduce((n, s) => n + s.activeAgents, 0);
  const projects = onlyLive ? data.projects.filter((p) => LIVE.has(p.status)) : data.projects;

  return (
    <>
      <section className="stats">
        <Stat label="Agentes trabajando" value={String(agentsNow)} accent="working" />
        <Stat label="Sesiones activas" value={String(working)} />
        <Stat label="Esperándote" value={String(waiting)} accent={waiting ? "waiting" : undefined} />
        <Stat label="Tokens hoy" value={fmtNum(freshTokens(data.tokensToday))} hint={`+${fmtNum(data.tokensToday.cacheRead)} de caché`} />
        <Stat label="Proyectos" value={String(data.projects.length)} hint={`últimos ${days} días`} />
      </section>

      <div className="toolbar">
        <div className="seg">
          <button className={!onlyLive ? "on" : ""} onClick={() => setOnlyLive(false)}>Todos</button>
          <button className={onlyLive ? "on" : ""} onClick={() => setOnlyLive(true)}>Solo activos</button>
        </div>
        <div className="seg">
          {[1, 7, 30, 365].map((d) => (
            <button key={d} className={days === d ? "on" : ""} onClick={() => setDays(d)}>
              {d === 1 ? "Hoy" : d === 365 ? "Año" : `${d} d`}
            </button>
          ))}
        </div>
      </div>

      {projects.length === 0 ? (
        <div className="empty">Ningún proyecto con actividad en este rango.</div>
      ) : (
        <section className="rooms">
          {projects.map((p) => (
            <Room key={p.key} project={p} now={now} />
          ))}
        </section>
      )}
    </>
  );
}

function Stat({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: string }) {
  return (
    <div className={`stat ${accent ? `stat-${accent}` : ""}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

function Room({ project, now }: { project: ProjectView; now: number }) {
  const [open, setOpen] = useState(false);
  const shown = open ? project.sessions : project.sessions.slice(0, 3);
  return (
    <article className={`room room-${project.status}`}>
      <header className="room-head">
        <span className={`dot dot-${project.status}`} title={STATUS_LABEL[project.status]} />
        <a href={projectHref(project.key)} className="room-title"><h2>{project.name}</h2></a>
        {!project.mapped && <span className="tag" title="Este proyecto no tiene PROYECTO.md en el vault">sin vault</span>}
        <span className="room-meta">{timeAgo(project.lastEventAt, now)}</span>
      </header>
      <DeptStrip departments={project.departments} href={projectHref(project.key)} />
      {project.sessions.length === 0 && <div className="muted small room-empty">Sin sesiones de agentes todavía.</div>}
      <ul className="sessions">
        {shown.map((s) => (
          <SessionRow key={s.id} s={s} now={now} />
        ))}
      </ul>
      {project.sessions.length > 3 && (
        <button className="more" onClick={() => setOpen(!open)}>
          {open ? "Mostrar menos" : `+${project.sessions.length - 3} sesiones`}
        </button>
      )}
      <footer className="room-foot">
        <span>{project.sessions.length} sesiones</span>
        <span>hoy {fmtNum(freshTokens(project.tokensToday))} tokens</span>
      </footer>
    </article>
  );
}

function SessionRow({ s, now }: { s: SessionView; now: number }) {
  const live = LIVE.has(s.status);
  return (
    <li>
      <a className={`session ${live ? "session-live" : ""}`} href={`#/s/${s.id}`}>
        <span className={`dot dot-${s.status}`} />
        <div className="session-body">
          <div className="session-title">
            {s.title ?? "Sesión sin título"}
            {s.activeAgents > 1 && <span className="crowd">{s.activeAgents} agentes</span>}
          </div>
          {live && s.current && <div className="session-current">{s.current}</div>}
        </div>
        <div className="session-side">
          <span className={`chip chip-${modelTier(s.model)}`}>{modelLabel(s.model)}</span>
          <span className="muted">{timeAgo(s.lastEventAt, now)}</span>
        </div>
      </a>
    </li>
  );
}
