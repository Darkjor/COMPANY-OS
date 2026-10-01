import type { DeliverableType, ReviewVerdict } from "./api.ts";

/** Pure helpers for the deliverable reader: no React, so they can be unit-tested from tests/. */

export interface Section {
  /** H2 text, "" for the lead-in before the first H2. */
  heading: string;
  /** Markdown of the section, heading line included. */
  md: string;
}

export interface ParsedDoc {
  title: string | null;
  /** Body without the H1 (and, for para-direccion, without the metadata bullet list). */
  body: string;
  date: string | null;
  project: string | null;
  fullPath: string | null;
  reviewPath: string | null;
  verdict: ReviewVerdict | null;
}

export const MAX_CHARS = 300_000;

export function typeFromName(name: string): DeliverableType {
  const n = name.toLowerCase();
  if (n.startsWith("para-direccion")) return "para-direccion";
  if (n.startsWith("informe") || n.startsWith("report")) return "informe";
  if (n.startsWith("revision") || n.startsWith("review")) return "revision";
  if (n.startsWith("plan")) return "plan";
  if (n.startsWith("brief")) return "brief";
  return "otro";
}

export const dirname = (path: string) => path.split("/").slice(0, -1).join("/");
export const basename = (path: string) => path.split("/").pop() ?? path;

/** "Proyectos/<slug>/<dept>/<folder>/<file>" → parts, or nulls when the path does not follow the convention. */
export function pathParts(path: string): { project: string | null; department: string | null } {
  const m = /^Proyectos\/([^/]+)\/([^/]+)\//.exec(path);
  return { project: m?.[1] ?? null, department: m?.[2] ?? null };
}

const META_KEYS = /^(fecha|proyecto|entregable completo|revisi[oó]n de calidad)\b/i;

/** First backtick-quoted path in a metadata line. */
const firstCode = (line: string) => /`([^`]+)`/.exec(line)?.[1].replace(/\\/g, "/") ?? null;

export function parseVerdict(text: string): ReviewVerdict | null {
  const t = text.toLowerCase();
  if (/rechazad/.test(t)) return "rechazado";
  if (/con correcciones/.test(t)) return "con-correcciones";
  if (/aprobad/.test(t)) return "aprobado";
  return null;
}

/** Splits at fenced code blocks safely: `# x` inside a fence is not a heading. */
function eachLine(md: string): { line: string; fenced: boolean }[] {
  let fence = false;
  return md.split(/\r?\n/).map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      return { line, fenced: true };
    }
    return { line, fenced: fence };
  });
}

export function parseDoc(content: string, type: DeliverableType): ParsedDoc {
  const lines = eachLine(content);
  let title: string | null = null;
  let titleIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const { line, fenced } = lines[i];
    if (fenced) continue;
    if (/^##\s/.test(line)) break; // the title must come before the first H2
    const m = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      title = m[1].replace(/\s+[—–-]\s+para direcci[oó]n\s*$/i, "").trim();
      titleIdx = i;
      break;
    }
  }

  const out: ParsedDoc = { title, body: "", date: null, project: null, fullPath: null, reviewPath: null, verdict: null };
  const drop = new Set<number>();
  if (titleIdx >= 0) drop.add(titleIdx);

  // Metadata bullets live in the header, before the first H2 (or horizontal rule).
  for (let i = titleIdx + 1; i < lines.length; i++) {
    const { line, fenced } = lines[i];
    if (fenced || /^##\s/.test(line) || /^---+\s*$/.test(line)) break;
    const m = /^\s*[-*]\s+(.+)$/.exec(line);
    if (!m || !META_KEYS.test(m[1])) continue;
    const key = m[1].toLowerCase();
    const value = m[1].replace(/^[^:]+:\s*/, "");
    if (key.startsWith("fecha")) out.date = /\d{4}-\d{2}-\d{2}/.exec(value)?.[0] ?? null;
    else if (key.startsWith("proyecto")) out.project = (firstCode(value) ?? value.split(/\s/)[0]).trim();
    else if (key.startsWith("entregable")) out.fullPath = firstCode(value);
    else {
      out.reviewPath = firstCode(value);
      out.verdict = parseVerdict(value.replace(/`[^`]*`/g, ""));
    }
    // Only the executive page hides its bullets: the full report keeps its own header as written.
    if (type === "para-direccion") drop.add(i);
  }

  out.body = lines
    .filter((_, i) => !drop.has(i))
    .map((l) => l.line)
    .join("\n")
    .replace(/^\s+/, "");
  return out;
}

const slugify = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export const headingId = (text: string) => `h-${slugify(text)}`;

export function splitSections(md: string): Section[] {
  const sections: Section[] = [{ heading: "", md: "" }];
  for (const { line, fenced } of eachLine(md)) {
    const m = !fenced ? /^##\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (m) sections.push({ heading: m[1], md: line + "\n" });
    else sections[sections.length - 1].md += line + "\n";
  }
  return sections.filter((s) => s.heading || s.md.trim());
}

export const isDecideHeading = (heading: string) => /^qu[eé] se pide decidir/i.test(heading.trim());

/** True when at least one "- [ ]" is still open. */
export const hasPendingDecision = (md: string) =>
  eachLine(md).some(({ line, fenced }) => !fenced && /^\s*[-*+]\s+\[ \]/.test(line));

/** Resolves a link written in a document ("../x/informe.md") against the document's folder, or null if it escapes. */
export function resolveRelative(docPath: string, href: string): string | null {
  const parts = dirname(docPath).split("/").filter(Boolean);
  for (const seg of href.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.pop()) return null;
    } else parts.push(seg);
  }
  return parts.join("/");
}

/** A backtick-quoted vault path worth turning into a link. */
export const looksLikeVaultPath = (text: string) => /^Proyectos\/[^\s`]+\.(md|txt|json|csv|ya?ml)$/i.test(text.replace(/\\/g, "/"));

export type LinkKind = "external" | "internal" | "none";

/** Only http(s) and in-vault documents become links; javascript:, data:, etc. are dropped (spec §5). */
export function classifyHref(href: string | undefined): LinkKind {
  if (!href) return "none";
  const h = href.trim();
  if (/^https?:\/\//i.test(h)) return "external";
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith("//") || h.startsWith("#")) return "none";
  return /\.(md|txt|json|csv|ya?ml)(#.*)?$/i.test(h) ? "internal" : "none";
}

/** First `Proyectos/…/revision*.md` quoted in the first lines of a report's header (backslashes allowed). */
export function citedReviewPath(content: string): string | null {
  const head = content.split(/\r?\n/).slice(0, 15).join("\n").replace(/\\/g, "/");
  return /Proyectos\/[^\s`'"()<>]+\/revision[^\s`'"()<>/]*\.md/i.exec(head)?.[0] ?? null;
}

/** Where a report's review lives: (a) a `revision*.md` in the same folder, else (b) the one the report cites. */
export function reviewCandidate(docPath: string, content: string, deliverablePaths: string[]): string | null {
  const folder = dirname(docPath);
  const sibs = deliverablePaths.filter((p) => dirname(p) === folder && /^revision[^/]*\.md$/i.test(basename(p)));
  if (sibs.length) return sibs.find((p) => /seguimiento/i.test(p)) ?? sibs[0];
  return citedReviewPath(content);
}

/** The newest review of a delivery is a `revision-seguimiento.md` next to the original one. */
export const followUpOf = (reviewPath: string) => `${dirname(reviewPath)}/revision-seguimiento.md`;

/** Verdict from the `## N. Veredicto[ final]: <TEXTO>` heading of a review. */
export function reviewVerdictFromDoc(md: string): ReviewVerdict | null {
  for (const { line, fenced } of eachLine(md)) {
    if (fenced) continue;
    const m = /^##\s+(?:\d+\.\s*)?veredicto(?:\s+final)?\s*:\s*(.+?)\s*#*\s*$/i.exec(line);
    if (m) return parseVerdict(m[1]);
  }
  return null;
}
