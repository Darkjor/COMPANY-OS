import type { CrewMember, DeptSummary, SessionView, Status } from "./api.ts";
import { STATUS_LABEL, plural, timeAgo } from "./format.ts";
import { Desk, Drone, Worker } from "./pixel/Sprites.tsx";

export const LIVE: ReadonlySet<Status> = new Set(["working", "subagents", "waiting", "error"]);

/** Three-letter nameplate for a department ("Diseño" → "DIS"). */
export function deptCode(name: string): string {
  return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase();
}

export function caption(s: SessionView, now: number): string {
  if (s.status === "waiting") return `te espera · ${timeAgo(s.lastEventAt, now).replace("hace ", "")}`;
  if (s.status === "error") return "falló · revisar";
  return s.current ?? STATUS_LABEL[s.status];
}

function Seat({ s, now }: { s: SessionView; now: number }) {
  const status: Status = s.status === "subagents" ? "working" : s.status;
  const drones = Math.min(s.drones, 4);
  return (
    <a
      className={`seat seat-${s.status}`}
      href={`#/s/${s.id}`}
      title={`${s.title ?? "Sesión"} · ${STATUS_LABEL[s.status]}${s.current ? ` · ${s.current}` : ""}`}
    >
      <span className="seat-figure">
        <Worker
          seed={s.id}
          model={s.model}
          status={status}
          hat={s.hat?.department}
          label={`${s.hat?.name ?? s.title ?? "Agente"}: ${STATUS_LABEL[s.status]}`}
        />
        {drones > 0 && (
          <span className="drones">
            {Array.from({ length: drones }, (_, i) => (
              <Drone key={i} />
            ))}
          </span>
        )}
      </span>
      <Desk lit={status === "working"} />
      <span className="seat-caption">
        {s.hat && <span className="seat-hat">{s.hat.name}</span>} {caption(s, now)}
      </span>
    </a>
  );
}

/** A subagent wearing a HAT, seated at its own department's desk; clicking opens its parent session. */
function CrewSeat({ c }: { c: CrewMember }) {
  const status: Status = c.status === "subagents" ? "working" : c.status;
  const sessionId = c.id.split("/")[0];
  return (
    <a className={`seat seat-${c.status}`} href={`#/s/${sessionId}`} title={`${c.hat} · ${STATUS_LABEL[c.status]}${c.current ? ` · ${c.current}` : ""}`}>
      <span className="seat-figure">
        <Worker seed={c.id} model={c.model} status={status} hat={c.department} label={`${c.hat}: ${STATUS_LABEL[c.status]}`} />
      </span>
      <Desk lit={status === "working"} />
      <span className="seat-caption">
        <span className="seat-hat">{c.hat}</span> {c.status === "working" ? c.current : STATUS_LABEL[c.status]}
      </span>
    </a>
  );
}

function Station({ dept, sessions, crew, now }: { dept: DeptSummary; sessions: SessionView[]; crew: CrewMember[]; now: number }) {
  const live = sessions.filter((s) => LIVE.has(s.status));
  const seated = live.length + crew.length;
  return (
    <div className={`station ${seated ? "station-live" : ""}`}>
      <span className="plate" title={dept.name}>{deptCode(dept.name)}</span>
      <div className="station-seats">
        {seated === 0 ? (
          <span className="seat seat-empty" aria-label={`${dept.name}: sin agentes`}>
            <span className="seat-figure" />
            <Desk lit={false} />
            <span className="seat-caption">{dept.sessions ? plural(dept.sessions, "sesión", "sesiones") : "libre"}</span>
          </span>
        ) : (
          <>
            {live.slice(0, 4).map((s) => (
              <Seat key={s.id} s={s} now={now} />
            ))}
            {crew.slice(0, 4).map((c) => (
              <CrewSeat key={c.id} c={c} />
            ))}
          </>
        )}
        {(live.length > 4 || crew.length > 4) && (
          <span className="overflow">+{Math.max(0, live.length - 4) + Math.max(0, crew.length - 4)}</span>
        )}
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
          <Station
            key={d.slug}
            dept={d}
            sessions={sessions.filter((s) => s.department === d.slug)}
            crew={sessions.flatMap((s) => s.crew.filter((c) => c.department === d.slug))}
            now={now}
          />
        ))}
      </div>
    </section>
  );
}
