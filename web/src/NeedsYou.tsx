import type { ProjectView, SessionView } from "./api.ts";
import { timeAgo } from "./format.ts";
import { deptCode } from "./Office.tsx";
import { Worker } from "./pixel/Sprites.tsx";

interface Call {
  s: SessionView;
  project: ProjectView;
}

/** Errors first, then whoever has been waiting longest. */
export function collectCalls(projects: ProjectView[]): Call[] {
  const calls = projects.flatMap((project) =>
    project.sessions.filter((s) => s.status === "waiting" || s.status === "error").map((s) => ({ s, project })),
  );
  return calls.sort((a, b) => {
    if (a.s.status !== b.s.status) return a.s.status === "error" ? -1 : 1;
    return (a.s.lastEventAt ?? "").localeCompare(b.s.lastEventAt ?? "");
  });
}

export function NeedsYou({ calls, now, working }: { calls: Call[]; now: number; working: number }) {
  if (calls.length === 0) {
    return (
      <section className="calls calls-clear" aria-live="polite">
        <span className="calls-title">Nadie te espera</span>
        <span className="muted">{working ? `${working} ${working === 1 ? "agente trabajando" : "agentes trabajando"} por su cuenta.` : "La oficina está en calma."}</span>
      </section>
    );
  }
  return (
    <section className="calls" aria-live="polite" aria-label="Agentes que te necesitan">
      <h2 className="calls-title">
        Te {calls.length === 1 ? "necesita" : "necesitan"} <span className="calls-count">{calls.length}</span>
      </h2>
      <ol className="call-list">
        {calls.map(({ s, project }) => {
          const dept = project.departments.find((d) => d.slug === s.department);
          return (
            <li key={s.id}>
              <a className={`call call-${s.status}`} href={`#/s/${s.id}`}>
                <Worker seed={s.id} model={s.model} status={s.status} scale={3} />
                <span className="call-body">
                  <span className="call-where">
                    {project.name}
                    {dept && <span className="call-dept">{deptCode(dept.name)}</span>}
                  </span>
                  <span className="call-title">{s.title ?? "Sesión sin título"}</span>
                  <span className="call-when">
                    {s.status === "error" ? "Falló " : "Esperando desde "}
                    {timeAgo(s.lastEventAt, now)}
                  </span>
                </span>
              </a>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
