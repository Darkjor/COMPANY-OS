import type { DeptSummary, SessionView, Status } from "./api.ts";
import { STATUS_LABEL, plural, timeAgo } from "./format.ts";
import { Desk, Drone, Worker } from "./pixel/Sprites.tsx";

export const LIVE: ReadonlySet<Status> = new Set(["working", "subagents", "waiting", "error"]);

/** Three-letter nameplate for a department ("Diseño" → "DIS"). */
export function deptCode(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase();
}

export function caption(s: SessionView, now: number): string {
  if (s.status === "waiting") return `te espera · ${timeAgo(s.lastEventAt, now).replace("hace ", "")}`;
  if (s.status === "error") return "falló · revisar";
  return s.current ?? STATUS_LABEL[s.status];
}

function Seat({ s, now }: { s: SessionView; now: number }) {
  const status: Status = s.status === "subagents" ? "working" : s.status;
  const drones = Math.max(0, Math.min(s.activeAgents - 1, 4));
  return (
    <a
      className={`seat seat-${s.status}`}
      href={`#/s/${s.id}`}
      title={`${s.title ?? "Sesión"} · ${STATUS_LABEL[s.status]}${s.current ? ` · ${s.current}` : ""}`}
    >
      <span className="seat-figure">
        <Worker seed={s.id} model={s.model} status={status} label={`${s.title ?? "Agente"}: ${STATUS_LABEL[s.status]}`} />
        {drones > 0 && (
          <span className="drones">
            {Array.from({ length: drones }, (_, i) => (
              <Drone key={i} />
            ))}
          </span>
        )}
      </span>
      <Desk lit={status === "working"} />
      <span className="seat-caption">{caption(s, now)}</span>
    </a>
  );
}

function Station({ dept, sessions, now }: { dept: DeptSummary; sessions: SessionView[]; now: number }) {
  const live = sessions.filter((s) => LIVE.has(s.status));
  return (
    <div className={`station ${live.length ? "station-live" : ""}`}>
      <span className="plate" title={dept.name}>{deptCode(dept.name)}</span>
      <div className="station-seats">
        {live.length === 0 ? (
          <span className="seat seat-empty" aria-label={`${dept.name}: sin agentes`}>
            <span className="seat-figure" />
            <Desk lit={false} />
            <span className="seat-caption">{dept.sessions ? plural(dept.sessions, "sesión", "sesiones") : "libre"}</span>
          </span>
        ) : (
          live.slice(0, 4).map((s) => <Seat key={s.id} s={s} now={now} />)
        )}
        {live.length > 4 && <span className="overflow">+{live.length - 4}</span>}
      </div>
    </div>
  );
}

/** One project drawn as a room on the floor: a station per department, agents seated where they work. */
export function Room({
  name,
  href,
  departments,
  sessions,
  now,
  meta,
}: {
  name: string;
  href?: string;
  departments: DeptSummary[];
  sessions: SessionView[];
  now: number;
  meta?: string;
}) {
  const title = <span className="room-name">{name}</span>;
  return (
    <section className="room" aria-label={`Sala ${name}`}>
      <header className="room-plate">
        {href ? <a href={href}>{title}</a> : title}
        {meta && <span className="room-meta">{meta}</span>}
      </header>
      <div className="floor">
        {departments.map((d) => (
          <Station key={d.slug} dept={d} sessions={sessions.filter((s) => s.department === d.slug)} now={now} />
        ))}
      </div>
    </section>
  );
}
