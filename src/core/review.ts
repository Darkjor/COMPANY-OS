import { dirname } from "node:path";
import { readVaultHead } from "./vault.ts";

/**
 * Review verdict of a deliverable, read from the documents themselves (never assumed). Same rules as the
 * reader (`web/src/readerDoc.ts`): a `para-direccion` states it in its "Revisión de calidad" line; a report
 * (informe/plan) has it in the `## N. Veredicto[ final]: X` heading of its review, and a
 * `revision-seguimiento.md` next to that review wins (it is the newest).
 */

export type ReviewVerdict = "aprobado" | "con-correcciones" | "rechazado" | "sin-revisar";

export interface ReviewInfo {
  review: ReviewVerdict | null;
  /** Vault path of the review that decides; null when there is none. */
  reviewPath: string | null;
}

const NONE: ReviewInfo = { review: null, reviewPath: null };
const REVIEW_BYTES = 16_384;

export function parseVerdict(text: string): ReviewVerdict | null {
  const t = text.toLowerCase();
  if (/sin revis/.test(t)) return "sin-revisar";
  if (/rechazad/.test(t)) return "rechazado";
  if (/con correcciones/.test(t)) return "con-correcciones";
  if (/aprobad/.test(t)) return "aprobado";
  return null;
}

/** Lines outside fenced code blocks. */
function plainLines(md: string): string[] {
  let fence = false;
  const out: string[] = [];
  for (const line of md.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence) out.push(line);
  }
  return out;
}

/** Verdict from the `## N. Veredicto[ final]: <TEXTO>` heading of a review. */
export function headingVerdict(md: string): ReviewVerdict | null {
  for (const line of plainLines(md)) {
    const m = /^##\s+(?:\d+\.\s*)?veredicto(?:\s+final)?\s*:\s*(.+?)\s*#*\s*$/i.exec(line);
    if (m) return parseVerdict(m[1]);
  }
  return null;
}

/** The "Revisión de calidad: …" metadata bullet of a header (before the first H2). */
function reviewMetaLine(md: string): { verdict: ReviewVerdict | null; path: string | null } | null {
  for (const line of plainLines(md)) {
    if (/^##\s/.test(line)) break;
    const m = /^\s*[-*]\s+revisi[oó]n(?: de calidad)?\s*:\s*(.+)$/i.exec(line);
    if (!m) continue;
    const path = /`([^`]+)`/.exec(m[1])?.[1].replace(/\\/g, "/") ?? null;
    return { verdict: parseVerdict(m[1].replace(/`[^`]*`/g, "")), path };
  }
  return null;
}

/** First `Proyectos/…/revision*.md` cited in the first lines of a report's header. */
export function citedReviewPath(md: string): string | null {
  const head = md.split(/\r?\n/).slice(0, 15).join("\n").replace(/\\/g, "/");
  return /Proyectos\/[^\s`'"()<>]+\/revision[^\s`'"()<>/]*\.md/i.exec(head)?.[0] ?? null;
}

const followUpOf = (reviewPath: string) => `${dirname(reviewPath)}/revision-seguimiento.md`;

/** The review that decides for `candidate`: its follow-up when it exists, else itself; null when unreadable. */
function decidingReview(vaultDir: string, candidate: string): { path: string; md: string } | null {
  const follow = followUpOf(candidate);
  const newer = follow === candidate ? null : readVaultHead(vaultDir, follow, REVIEW_BYTES);
  if (newer !== null) return { path: follow, md: newer };
  const md = readVaultHead(vaultDir, candidate, REVIEW_BYTES);
  return md === null ? null : { path: candidate, md };
}

export function reviewOf(vaultDir: string, path: string, type: string, head: string | null): ReviewInfo {
  if (type === "para-direccion") {
    const meta = head ? reviewMetaLine(head) : null;
    const verdict = meta?.verdict ?? (head ? headingVerdict(head) : null) ?? "sin-revisar";
    const cited = meta?.path ? decidingReview(vaultDir, meta.path) : null;
    return { review: verdict, reviewPath: cited?.path ?? null };
  }
  if (type !== "informe" && type !== "plan") return NONE;
  const folder = dirname(path);
  const found =
    decidingReview(vaultDir, `${folder}/revision.md`) ??
    (head && citedReviewPath(head) ? decidingReview(vaultDir, citedReviewPath(head)!) : null);
  if (!found) return { review: "sin-revisar", reviewPath: null };
  return { review: headingVerdict(found.md) ?? "sin-revisar", reviewPath: found.path };
}
