import { sessionHref } from "./api.ts";
import { STATUS_LABEL, plural } from "./format.ts";
import { HAT_LABEL, SIGNAL_LABEL } from "./signals.ts";
import { MAX_CHIPS, memberBlocking, memberGlyph, type TeamInfo } from "./teams.ts";

/** One line under the room plate per live team: dept chips with a status glyph; hovering any of it lights the whole team. */
export function TeamStrip({ info, codeOf }: { info: TeamInfo; codeOf: (slug: string | null) => string }) {
  const { letter, team, leader } = info;
  const shown = team.members.slice(0, MAX_CHIPS);
  const more = team.members.length - shown.length;
  return (
    <div className="team-strip" data-team={letter} role="group" aria-label={`Equipo ${letter}: ${team.name}`}>
      <span className="team-strip-name">EQUIPO {letter}</span>
      <span className="team-strip-title" title={team.description ?? team.name}>
        <span aria-hidden>★ </span>
        {team.name}
      </span>
      <span className="team-chips">
        {shown.map((m) => {
          const block = memberBlocking(m);
          const state = block ? SIGNAL_LABEL[block].toLowerCase() : STATUS_LABEL[m.status].toLowerCase();
          return (
            <a
              key={m.name}
              className={`team-chip${block ? ` team-chip-${block}` : ""}`}
              data-team={letter}
              href={sessionHref(leader.id, m.name)}
              title={`${m.hat ? HAT_LABEL(m.hat) : m.name} · ${state}`}
              aria-label={`${m.hat ? HAT_LABEL(m.hat) : m.name}, ${state}. Abrir la sesión del líder`}
            >
              {codeOf(m.department)} <span aria-hidden>{memberGlyph(m)}</span>
            </a>
          );
        })}
        {more > 0 && <span className="team-chip team-chip-more">+{more}</span>}
      </span>
      <span className="team-strip-count">{plural(team.members.length, "miembro", "miembros")}</span>
    </div>
  );
}
