import { useState } from "react";
import { deliverableHref, isLocallySeen, useSeenVersion, type Deliverable, type DeliverableType } from "./api.ts";
import { timeAgo } from "./format.ts";
import { deptCode } from "./Office.tsx";
import { ReviewBadge, reviewOf } from "./ReviewBadge.tsx";
import { HAT_LABEL, isNewDeliverable } from "./signals.ts";

export const KIND_LABEL: Record<DeliverableType, string> = {
  "para-direccion": "PARA DIR",
  informe: "INFORME",
  revision: "REVISIÓN",
  plan: "PLAN",
  brief: "BRIEF",
  otro: "OTRO",
};

type Filter = "all" | "exec" | "report" | "review" | "other";

const FILTERS: { id: Filter; label: string; match: (d: Deliverable) => boolean }[] = [
  { id: "all", label: "Todos", match: () => true },
  { id: "exec", label: "Para dirección", match: (d) => d.type === "para-direccion" },
  { id: "report", label: "Informes", match: (d) => d.type === "informe" || d.type === "plan" },
  { id: "review", label: "Revisiones", match: (d) => d.type === "revision" },
  { id: "other", label: "Otros", match: (d) => d.type === "brief" || d.type === "otro" },
];

export const PAGE = 8;

/** Reviews carry no verdict of their own; reports with none are "sin revisar". */
const verdictOf = (d: Deliverable) => (d.type === "revision" ? null : reviewOf(d));

function Row({ d, now, deptNames }: { d: Deliverable; now: number; deptNames: Map<string, string> }) {
  const fresh = isNewDeliverable(d, isLocallySeen);
  const verdict = verdictOf(d);
  const deptName = deptNames.get(d.department) ?? d.department;
  return (
    <li className="dl-row">
      <span className={`dl-kind dl-kind-${d.type}`}>{KIND_LABEL[d.type]}</span>
      <a className="dl-title" href={deliverableHref(d.path)} title={d.path}>
        {d.title}
      </a>
      <span className="dl-meta">
        <span className="dl-code" title={deptName}>{deptCode(deptName)}</span>
        {d.hat ? HAT_LABEL(d.hat) : "—"}
      </span>
      <span className="dl-meta dl-review">{verdict ? <ReviewBadge verdict={verdict} /> : <span aria-hidden>—</span>}</span>
      <span className="dl-when">
        {fresh && <span className="dl-new">NUEVO</span>}
        {timeAgo(d.at, now)}
      </span>
    </li>
  );
}

/**
 * Deliverables of a project (filters, 8 rows + "Ver los N") or, with `compact`, of one session (no filters).
 * Newest first; "NUEVO" until the owner opens it (seenAt).
 */
export function DeliverableList({
  items,
  now,
  departments,
  compact = false,
  title = "Entregables",
}: {
  items: Deliverable[] | null;
  now: number;
  departments: { slug: string; name: string }[];
  compact?: boolean;
  title?: string;
}) {
  useSeenVersion(); // "NUEVO" must go away the moment a report is opened
  const [filter, setFilter] = useState<Filter>("all");
  const [all, setAll] = useState(false);
  const deptNames = new Map(departments.map((d) => [d.slug, d.name]));

  if (items === null) return <p className="muted small">Cargando entregables…</p>;
  const sorted = [...items].sort((a, b) => b.at.localeCompare(a.at));
  const active = FILTERS.find((f) => f.id === filter) ?? FILTERS[0];
  const filtered = sorted.filter(active.match);
  const shown = all || compact ? filtered : filtered.slice(0, PAGE);

  return (
    <section className={`dl ${compact ? "dl-compact" : ""}`} aria-label={title}>
      <div className="dl-head">
        <h2 className="section-label">{title}</h2>
        {!compact && sorted.length > 0 && (
          <div className="dl-filters" role="group" aria-label="Filtrar entregables">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={filter === f.id}
                onClick={() => {
                  setFilter(f.id);
                  setAll(false);
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {sorted.length === 0 ? (
        <p className="dl-empty">Todavía no hay entregables. Cuando un agente escriba uno en el vault, aparecerá aquí.</p>
      ) : filtered.length === 0 ? (
        <p className="dl-empty">No hay entregables de este tipo.</p>
      ) : (
        <>
          <ul className="dl-list">
            {shown.map((d) => (
              <Row key={d.path} d={d} now={now} deptNames={deptNames} />
            ))}
          </ul>
          {!compact && filtered.length > PAGE && (
            <button type="button" className="dl-more" aria-expanded={all} onClick={() => setAll(!all)}>
              {all ? "Ver menos" : `Ver los ${filtered.length} entregables`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
