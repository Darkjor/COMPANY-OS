import { useState } from "react";
import { projectHref, useLive, useNow, type Overview, type ProjectView } from "./api.ts";
import { STATUS_LABEL, fmtNum, freshTokens, plural, timeAgo } from "./format.ts";
import { NeedsYou, collectCalls } from "./NeedsYou.tsx";
import { LIVE, Room, deptCode } from "./Office.tsx";

const RANGES = [
  { days: 7, label: "7 días" },
  { days: 30, label: "30 días" },
  { days: 365, label: "Año" },
];

export function Company() {
  const [days, setDays] = useState(30);
  const { data, error } = useLive<Overview>(`/api/overview?days=${days}`);
  const now = useNow();

  if (error && !data) return <div className="empty">Sin conexión con el observador. ¿Está corriendo <span className="mono">npm start</span>? ({error})</div>;
  if (!data) return <div className="empty">Abriendo la oficina…</div>;

  const sessions = data.projects.flatMap((p) => p.sessions);
  const working = sessions.reduce((n, s) => n + (s.status === "working" || s.status === "subagents" ? Math.max(1, s.activeAgents) : 0), 0);
  const calls = collectCalls(data.projects);
  const live = data.projects.filter((p) => p.sessions.some((s) => LIVE.has(s.status)));
  const archive = data.projects.filter((p) => !live.includes(p));

  return (
    <>
      <div className="hud" role="status">
        <span className="hud-item hud-work"><b>{working}</b> trabajando</span>
        <span className={`hud-item ${calls.length ? "hud-call" : ""}`}><b>{calls.length}</b> te esperan</span>
        <span className="hud-item"><b>{live.length}</b> salas activas</span>
        <span className="hud-item hud-tokens" title={`${fmtNum(data.tokensToday.cacheRead)} tokens leídos de caché`}>
          <b>{fmtNum(freshTokens(data.tokensToday))}</b> tokens hoy
        </span>
      </div>

      <NeedsYou calls={calls} now={now} working={working} />

      <h2 className="section-label">El piso</h2>
      {live.length === 0 ? (
        <p className="floor-empty">Ninguna sala encendida. Cuando un agente empiece a trabajar, su proyecto aparece aquí.</p>
      ) : (
        <div className="rooms">
          {live.map((p) => (
            <Room
              key={p.key}
              name={p.name}
              href={projectHref(p.key)}
              departments={p.departments}
              sessions={p.sessions}
              now={now}
              meta={`${STATUS_LABEL[p.status]} · ${timeAgo(p.lastEventAt, now)}`}
            />
          ))}
        </div>
      )}

      <div className="section-row">
        <h2 className="section-label">Archivo</h2>
        <div className="range" role="group" aria-label="Rango de actividad">
          {RANGES.map((r) => (
            <button key={r.days} aria-pressed={days === r.days} onClick={() => setDays(r.days)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {archive.length === 0 ? (
        <p className="muted small">Nada más en este rango.</p>
      ) : (
        <ul className="ledger">
          {archive.map((p) => (
            <LedgerRow key={p.key} p={p} now={now} />
          ))}
        </ul>
      )}
    </>
  );
}

function LedgerRow({ p, now }: { p: ProjectView; now: number }) {
  return (
    <li>
      <a className="ledger-row" href={projectHref(p.key)}>
        <span className="ledger-name">
          {p.name}
          {!p.mapped && <span className="tag" title="Sin PROYECTO.md en el vault">sin ficha</span>}
        </span>
        <span className="pips" aria-label="Departamentos con sesiones">
          {p.departments.map((d) => (
            <span key={d.slug} className={`pip ${d.sessions ? "pip-on" : ""}`} title={`${d.name}: ${d.sessions} sesiones`}>
              {deptCode(d.name)}
            </span>
          ))}
        </span>
        <span className="ledger-num">{plural(p.sessions.length, "sesión", "sesiones")}</span>
        <span className="ledger-num">{timeAgo(p.lastEventAt, now)}</span>
      </a>
    </li>
  );
}
