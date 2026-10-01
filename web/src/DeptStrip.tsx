import type { DeptSummary } from "./api.ts";
import { STATUS_LABEL } from "./format.ts";

/** Compact row of department "desks" — lit up when a department has live agents. */
export function DeptStrip({ departments, href }: { departments: DeptSummary[]; href: string }) {
  return (
    <a className="dept-strip" href={href} title="Ver la oficina del proyecto">
      {departments.map((d) => (
        <span
          key={d.slug}
          className={`desk desk-${d.sessions ? d.status : "empty"}`}
          title={`${d.name}: ${d.sessions} sesiones · ${STATUS_LABEL[d.status]}`}
        >
          <span className="desk-icon">{d.icon}</span>
          {d.activeAgents > 0 && <span className="desk-count">{d.activeAgents}</span>}
        </span>
      ))}
    </a>
  );
}
