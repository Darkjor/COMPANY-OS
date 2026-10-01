import { deliverableHref, isLocallySeen, markSeen, useSeenVersion, type ProjectView, type SessionView } from "./api.ts";
import { timeAgo } from "./format.ts";
import { deptCode } from "./Office.tsx";
import { DocIcon, Worker } from "./pixel/Sprites.tsx";
import { HAT_LABEL, SIGNAL_LABEL, compareCalls, isBlocking, signalOf, type Signal } from "./signals.ts";

export interface Call {
  s: SessionView;
  project: ProjectView;
  signal: Signal;
}

/** Spec §1 order: error > pide permiso > te pregunta > informe listo > terminó; ties by who waited longest. */
export function collectCalls(projects: ProjectView[]): Call[] {
  const calls: Call[] = [];
  for (const project of projects) {
    for (const s of project.sessions) {
      const signal = signalOf(s, isLocallySeen);
      if (!signal) continue;
      // A report already seen leaves the bar (it stays on the seat as "terminó").
      if (signal === "finished" && s.waitingKind === "delivered") continue;
      calls.push({ s, project, signal });
    }
  }
  return calls.sort(compareCalls);
}

function CallCard({ call, now }: { call: Call; now: number }) {
  const { s, project, signal } = call;
  const dept = project.departments.find((d) => d.slug === s.department);
  const d = s.deliverable;
  const where = (
    <span className="call-where">
      {project.name}
      {dept && <span className="call-dept">{deptCode(dept.name)}</span>}
    </span>
  );
  const verb = signal === "error" ? "Falló " : signal === "delivered" ? "Entregó " : signal === "finished" ? "Terminó " : "Esperando desde ";
  const when = (
    <span className="call-when">
      {verb}
      {timeAgo(s.lastEventAt, now)}
    </span>
  );
  const kind = <span className="call-kind">{SIGNAL_LABEL[signal]}</span>;

  if (signal === "delivered" && d) {
    const hat = s.hat?.name ?? d.hat;
    return (
      <article className="call call-delivered">
        <span className="call-art" aria-hidden>
          <Worker seed={s.id} model={s.model} status="waiting" signal="delivered" scale={3} hat={s.hat?.department} />
        </span>
        <span className="call-body">
          {where}
          {kind}
          <a className="call-title call-stretch" href={deliverableHref(d.path, true)} onClick={() => void markSeen(d.path)}>
            {d.title}
          </a>
          <span className="call-when">
            {hat ? `${HAT_LABEL(hat)} · ` : ""}
            {timeAgo(d.at, now)}
          </span>
          <span className="call-actions">
            <a className="call-open" href={deliverableHref(d.path, true)} onClick={() => void markSeen(d.path)}>
              Abrir informe
            </a>
            <button type="button" className="call-seen" onClick={() => void markSeen(d.path)}>
              Ya lo vi
            </button>
          </span>
        </span>
      </article>
    );
  }
  return (
    <a className={`call call-${signal}`} href={`#/s/${s.id}`}>
      <Worker seed={s.id} model={s.model} status={s.status} signal={signal} scale={3} hat={s.hat?.department} />
      <span className="call-body">
        {where}
        {kind}
        <span className="call-title">{s.title ?? "Sesión sin título"}</span>
        {when}
      </span>
    </a>
  );
}

export function NeedsYou({ calls, now, working }: { calls: Call[]; now: number; working: number }) {
  useSeenVersion();
  if (calls.length === 0) {
    return (
      <section className="calls calls-clear" aria-live="polite">
        <span className="calls-title">Nadie te espera</span>
        <span className="muted">{working ? `${working} ${working === 1 ? "agente trabajando" : "agentes trabajando"} por su cuenta.` : "La oficina está en calma."}</span>
      </section>
    );
  }
  const blocking = calls.filter((c) => isBlocking(c.signal)).length;
  const ready = calls.length - blocking;
  const onlyReports = blocking === 0;
  const latest = calls.find((c) => c.signal === "delivered" && c.s.deliverable);
  return (
    <section className={`calls ${onlyReports ? "calls-papers" : ""}`} aria-live="polite" aria-label="Agentes que te necesitan">
      <header className="calls-head">
        <h2 className="calls-title">
          {onlyReports ? (ready === 1 ? "Informe listo" : "Informes listos") : `Te ${blocking === 1 ? "necesita" : "necesitan"}`}
          <span className={`calls-count ${onlyReports ? "calls-count-paper" : ""}`}>{onlyReports ? ready : blocking}</span>
        </h2>
        {!onlyReports && ready > 0 && (
          <span className="calls-chip">
            <DocIcon scale={1} /> {ready} {ready === 1 ? "informe listo" : "informes listos"}
          </span>
        )}
      </header>
      <span className="sr-only">
        {latest ? `Informe listo: ${latest.s.deliverable?.title}` : ""}
      </span>
      <ol className="call-list">
        {calls.map((c) => (
          <li key={`${c.s.id}`}>
            <CallCard call={c} now={now} />
          </li>
        ))}
      </ol>
    </section>
  );
}
