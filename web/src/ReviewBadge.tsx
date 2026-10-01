import type { Deliverable, ReviewVerdict } from "./api.ts";

export const REVIEW_LABEL: Record<ReviewVerdict, string> = {
  aprobado: "Aprobado",
  "con-correcciones": "Aprobado con correcciones",
  rechazado: "Rechazado",
  "sin-revisar": "Sin revisar",
};

// Icon + text always: never color alone (spec §5).
const REVIEW_ICON: Record<ReviewVerdict, string> = { aprobado: "✓", "con-correcciones": "▲", rechazado: "✕", "sin-revisar": "?" };

/** A report with no verdict is "sin revisar" only when it is the kind that should be reviewed. */
export function reviewOf(d: Pick<Deliverable, "review" | "type">): ReviewVerdict | null {
  if (d.review) return d.review;
  return d.type === "informe" || d.type === "plan" ? "sin-revisar" : null;
}

export function reviewText(d: Pick<Deliverable, "review" | "type">): string | null {
  const r = reviewOf(d);
  return r ? REVIEW_LABEL[r] : null;
}

export function ReviewBadge({ verdict }: { verdict: ReviewVerdict }) {
  return (
    <span className={`review review-${verdict}`}>
      <span className="review-icon" aria-hidden>
        {REVIEW_ICON[verdict]}
      </span>
      {REVIEW_LABEL[verdict]}
    </span>
  );
}
