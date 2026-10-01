import { deliverableHref, isLocallySeen, sessionHref, useSeenVersion, type CrewMember, type DeptSummary, type SessionView, type Status, type TeamMember } from "./api.ts";
import { STATUS_LABEL, plural, timeAgo } from "./format.ts";
import { Desk, Drone, Worker } from "./pixel/Sprites.tsx";
import { reviewText } from "./ReviewBadge.tsx";
import { useSeatTip } from "./SeatTip.tsx";
import { HAT_LABEL, SIGNAL_LABEL, signalOf, signalText, type Signal } from "./signals.ts";
import { TeamStrip } from "./TeamStrip.tsx";
import { crewCoveredByMembers, memberBlocking, roomTeams, seatedMembers, type TeamInfo } from "./teams.ts";

/** Team mark of a seat: "★A" for the leader, "A" for a teammate. */
export interface Tag {
  letter: string;
  leader: boolean;
  teamName: string;
}

export const LIVE: ReadonlySet<Status> = new Set(["working", "subagents", "waiting", "error"]);

/** Three-letter nameplate for a department ("Diseño" → "DIS"). */
export function deptCode(name: string): string {
  return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase();
}

export function caption(s: SessionView, now: number, signal: Signal | null = signalOf(s, isLocallySeen)): string {
  const ago = timeAgo(s.lastEventAt, now).replace("hace ", "");
  if (signal === "error") return "falló · revisar";
  if (signal) return `${signalText(signal)} · ${ago}`;
  if (s.status === "waiting") return `te espera · ${ago}`;
  return s.current ?? STATUS_LABEL[s.status];
}

function TeamTag({ tag }: { tag: Tag }) {
  return (
    <span className="team-tag" data-team={tag.letter} title={`${tag.leader ? "Líder del equipo" : "Equipo"} ${tag.letter}: ${tag.teamName}`}>
      <span aria-hidden>
        {tag.leader ? "★" : ""}
        {tag.letter}
      </span>
      <span className="sr-only">{tag.leader ? `Líder del equipo ${tag.letter}` : `Equipo ${tag.letter}`}</span>
    </span>
  );
}

function TipBody({ s, signal, now, deptName }: { s: SessionView; signal: Signal | null; now: number; deptName?: string }) {
  const d = s.deliverable;
  const ago = timeAgo(s.lastEventAt, now);
  if (signal === "delivered" && d) {
    const hat = s.hat?.name ?? d.hat;
    const review = reviewText(d);
    return (
      <>
        <b className="tip-head">{SIGNAL_LABEL.delivered} · {ago}</b>
        <span className="tip-title">{d.title}</span>
        <span className="tip-meta">{[hat && hat.charAt(0).toUpperCase() + hat.slice(1), deptName, review && `Revisión: ${review.toLowerCase()}`].filter(Boolean).join(" · ")}</span>
        <span className="tip-hint">Clic: abrir informe · Mayús+clic: ver sesión</span>
      </>
    );
  }
  return (
    <>
      <b className="tip-head">{signal ? SIGNAL_LABEL[signal] : STATUS_LABEL[s.status].toUpperCase()} · {ago}</b>
      <span className="tip-title">{s.title ?? "Sesión sin título"}</span>
      {s.current && <span className="tip-meta">{s.current}</span>}
      <span className="tip-hint">Clic: abrir sesión</span>
    </>
  );
}

function Seat({ s, now, deptName, tag }: { s: SessionView; now: number; deptName?: string; tag?: Tag }) {
  const status: Status = s.status === "subagents" ? "working" : s.status;
  const drones = Math.min(s.drones, 4);
  const signal = signalOf(s, isLocallySeen);
  const toReport = signal === "delivered" && s.deliverable ? deliverableHref(s.deliverable.path, true) : null;
  const { ref, handlers, tip } = useSeatTip(<TipBody s={s} signal={signal} now={now} deptName={deptName} />);
  const who = s.hat?.name ?? s.title ?? "Agente";
  return (
    <>
      <a
        ref={ref}
        className={`seat seat-${s.status}${signal ? ` seat-sig-${signal}` : ""}`}
        data-team={tag?.letter}
        href={toReport ?? `#/s/${s.id}`}
        onClick={(e) => {
          // Shift+click on a ready report opens the session instead of the reader.
          if (toReport && e.shiftKey) {
            e.preventDefault();
            window.location.hash = `#/s/${s.id}`;
          }
        }}
        {...handlers}
        title={`${s.title ?? "Sesión"} · ${signal ? SIGNAL_LABEL[signal] : STATUS_LABEL[s.status]}${s.current ? ` · ${s.current}` : ""}`}
      >
        {tag && <TeamTag tag={tag} />}
        <span className="seat-figure">
          <Worker
            seed={s.id}
            model={s.model}
            status={status}
            signal={signal}
            hat={s.hat?.department}
            label={`${who}: ${signal ? signalText(signal) : STATUS_LABEL[s.status]}`}
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
          {s.hat && <span className="seat-hat">{s.hat.name}</span>} {caption(s, now, signal)}
        </span>
      </a>
      {tip}
    </>
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

/** A teammate: drawn as a worker wearing its HAT at its own department's desk (no drones, unlike subagents). */
function MemberSeat({ info, m }: { info: TeamInfo; m: TeamMember }) {
  const status: Status = m.status === "subagents" ? "working" : m.status;
  const block = memberBlocking(m);
  const signal: Signal | null = block ?? (m.status === "waiting" ? (m.waitingKind === "delivered" ? "delivered" : "finished") : null);
  const who = m.hat ? HAT_LABEL(m.hat) : m.name;
  const state = signal ? SIGNAL_LABEL[signal] : STATUS_LABEL[m.status].toUpperCase();
  const { ref, handlers, tip } = useSeatTip(
    <>
      <b className="tip-head">{state}</b>
      <span className="tip-title">{who}</span>
      <span className="tip-meta">
        {signal ? signalText(signal) : STATUS_LABEL[m.status].toLowerCase()} · equipo de «{info.leader.title ?? info.team.name}»
      </span>
      {m.current && m.status === "working" && <span className="tip-meta">{m.current}</span>}
      <span className="tip-hint">Clic: abrir la sesión del equipo</span>
    </>,
  );
  return (
    <>
      <a
        ref={ref}
        className={`seat seat-${m.status}${signal ? ` seat-sig-${signal}` : ""}`}
        data-team={info.letter}
        href={sessionHref(info.leader.id, m.name)}
        {...handlers}
        title={`${who} · ${state.toLowerCase()} · equipo de «${info.leader.title ?? info.team.name}»`}
      >
        <TeamTag tag={{ letter: info.letter, leader: false, teamName: info.team.name }} />
        <span className="seat-figure">
          <Worker seed={`${info.leader.id}/${m.name}`} model={m.model} status={status} signal={signal} hat={m.department} label={`${who}: ${state.toLowerCase()}`} />
        </span>
        <Desk lit={status === "working"} />
        <span className="seat-caption">
          {m.hat && <span className="seat-hat">{m.hat}</span>}{" "}
          {signal ? signalText(signal) : m.status === "working" ? m.current ?? "trabajando" : STATUS_LABEL[m.status].toLowerCase()}
        </span>
      </a>
      {tip}
    </>
  );
}

function Station({
  dept,
  sessions,
  crew,
  members,
  tagFor,
  now,
}: {
  dept: DeptSummary;
  sessions: SessionView[];
  crew: CrewMember[];
  members: { info: TeamInfo; m: TeamMember }[];
  tagFor: (sessionId: string) => Tag | undefined;
  now: number;
}) {
  const live = sessions.filter((s) => LIVE.has(s.status));
  const seated = live.length + crew.length + members.length;
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
              <Seat key={s.id} s={s} now={now} deptName={dept.name} tag={tagFor(s.id)} />
            ))}
            {members.slice(0, 4).map(({ info, m }) => (
              <MemberSeat key={`${info.leader.id}/${m.name}`} info={info} m={m} />
            ))}
            {crew.slice(0, 4).map((c) => (
              <CrewSeat key={c.id} c={c} />
            ))}
          </>
        )}
        {(live.length > 4 || crew.length > 4 || members.length > 4) && (
          <span className="overflow">
            +{Math.max(0, live.length - 4) + Math.max(0, crew.length - 4) + Math.max(0, members.length - 4)}
          </span>
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
  useSeenVersion(); // marking a report as seen redraws the seats before the server round-trip
  const teams = roomTeams(sessions);
  const roomIds = new Set(sessions.map((x) => x.id));
  const covered = crewCoveredByMembers(teams, roomIds);
  const tags = new Map<string, Tag>();
  for (const t of teams) {
    tags.set(t.leader.id, { letter: t.letter, leader: true, teamName: t.team.name });
    for (const m of t.team.members) if (m.sessionId) tags.set(m.sessionId, { letter: t.letter, leader: false, teamName: t.team.name });
  }
  const codeOf = (slug: string | null) => {
    const d = slug ? departments.find((x) => x.slug === slug) : undefined;
    return d ? deptCode(d.name) : slug ? deptCode(slug) : "—";
  };
  const title = <span className="room-name">{name}</span>;
  return (
    <section className="room" aria-label={`Sala ${name}`}>
      <header className="room-plate">
        {href ? <a href={href}>{title}</a> : title}
        {meta && <span className="room-meta">{meta}</span>}
      </header>
      {teams.map((t) => (
        <TeamStrip key={t.leader.id} info={t} codeOf={codeOf} />
      ))}
      <div className="floor">
        {departments.map((d) => (
          <Station
            key={d.slug}
            dept={d}
            sessions={sessions.filter((s) => s.department === d.slug)}
            crew={sessions.flatMap((s) => s.crew.filter((c) => c.department === d.slug && !covered.has(c.id)))}
            members={teams.flatMap((info) =>
              seatedMembers(info, roomIds)
                .filter((m) => m.department === d.slug)
                .map((m) => ({ info, m })),
            )}
            tagFor={(id) => tags.get(id)}
            now={now}
          />
        ))}
      </div>
    </section>
  );
}
