import { useEffect, useMemo, useRef, useState } from "react";
import { deliverableHref, markSeen, projectHref, useLive, useNow, type Deliverable, type DeliverableType, type ReviewVerdict } from "./api.ts";
import { timeAgo } from "./format.ts";
import { Markdown, nodeText } from "./Markdown.tsx";
import { ReviewBadge } from "./ReviewBadge.tsx";
import {
  MAX_CHARS,
  basename,
  dirname,
  hasPendingDecision,
  headingId,
  isDecideHeading,
  parseDoc,
  pathParts,
  splitSections,
  typeFromName,
} from "./readerDoc.ts";
import { HAT_LABEL } from "./signals.ts";
import { useFileExists, useReviewLink } from "./useReviewLink.ts";
import "./reader.css";

const TYPE_LABEL: Record<DeliverableType, string> = {
  "para-direccion": "Para dirección",
  informe: "Informe",
  revision: "Revisión",
  plan: "Plan",
  brief: "Brief",
  otro: "Documento",
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** `exists` false = the file is gone (disabled with `off`); null = still checking (disabled, keeps its label). */
function Access({ href, label, off, exists = true }: { href: string | null; label: string; off: string; exists?: boolean | null }) {
  if (href && exists === null) {
    return (
      <span className="btn btn-off" role="link" aria-disabled="true">
        {label}
      </span>
    );
  }
  return href && exists ? (
    <a className="btn" href={href}>
      {label}
    </a>
  ) : (
    <span className="btn btn-off" role="link" aria-disabled="true">
      {off}
    </span>
  );
}

export function Reader({ path, fromReady }: { path: string; fromReady: boolean }) {
  const now = useNow(15000);
  const [attempt, setAttempt] = useState(0);
  const file = useLive<{ path: string; content: string }>(`/api/vault/file?path=${encodeURIComponent(path)}&r=${attempt}`);
  const list = useLive<{ deliverables: Deliverable[] }>("/api/deliverables?limit=500");
  const all = list.data?.deliverables;
  const meta = all?.find((d) => d.path === path) ?? null;
  const parts = pathParts(path);
  const type: DeliverableType = meta?.type ?? typeFromName(basename(path));

  // From "Informe listo": prefer the session's para-direccion over whatever file was written last.
  const redirectTo = useMemo(() => {
    if (!fromReady || !all || type === "para-direccion") return null;
    const sid = meta?.sessionId;
    if (!sid) return null;
    return all.find((d) => d.sessionId === sid && d.type === "para-direccion" && d.path !== path) ?? null;
  }, [fromReady, all, type, meta, path]);

  useEffect(() => {
    if (!redirectTo) return;
    void markSeen(path); // the bar card is keyed on the file the agent wrote last
    window.location.replace(deliverableHref(redirectTo.path));
  }, [redirectTo, path]);

  // Opening marks seen: this file and the other new deliverables of the same folder (one delivery).
  const folder = dirname(path);
  const markable = useMemo(() => (all ?? []).filter((d) => dirname(d.path) === folder).map((d) => d.path).join("\n"), [all, folder]);
  useEffect(() => {
    if (redirectTo || !meta) return;
    markable.split("\n").filter(Boolean).forEach((p) => void markSeen(p));
  }, [redirectTo, meta, markable]);

  // "Actualizado hace un momento" when the agent rewrites the file while it is open.
  const lastContent = useRef<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const content = file.data?.content ?? null;
  useEffect(() => {
    if (content === null) return;
    if (lastContent.current !== null && lastContent.current !== content) setUpdatedAt(Date.now());
    lastContent.current = content;
  }, [content]);

  // The backend computes the real verdict and review path; the client-side search is only a fallback for old servers.
  const backend = meta !== null && meta.reviewPath !== undefined && (type === "para-direccion" || type === "informe" || type === "plan");
  const review = useReviewLink(path, content, backend ? "otro" : type, all ? all.map((d) => d.path) : list.error ? [] : null);
  const parsed = useMemo(() => (content === null ? null : parseDoc(content.slice(0, MAX_CHARS), type)), [content, type]);
  const truncated = (content?.length ?? 0) > MAX_CHARS;

  const siblings = (all ?? []).filter((d) => dirname(d.path) === folder);
  const hasExecutive = type === "para-direccion" || siblings.some((d) => d.type === "para-direccion");
  const reviewKnown = backend ? !!meta?.reviewPath : !!review.path;
  const unreviewed = (type === "informe" || type === "plan") && !hasExecutive && !reviewKnown && !review.pending;
  const verdict: ReviewVerdict | null = backend
    ? meta?.review ?? "sin-revisar" // the backend wins over whatever the document says
    : unreviewed
      ? "sin-revisar"
      : (review.path ? review.verdict : null) ?? meta?.review ?? parsed?.verdict ?? null;

  const fullPath = parsed?.fullPath ?? siblings.find((d) => d.type === "informe" || d.type === "plan")?.path ?? null;
  const reviewPath = backend
    ? meta?.reviewPath ?? null
    : unreviewed
      ? null
      : review.path ?? parsed?.reviewPath ?? siblings.find((d) => d.type === "revision")?.path ?? null;
  const fullLink = fullPath && fullPath !== path ? fullPath : null;
  const fullExists = useFileExists(fullLink);
  const reviewExists = useFileExists(reviewPath);
  const sessionId = meta?.sessionId ?? null;
  const project = meta?.project ?? parts.project ?? parsed?.project ?? null;
  const dept = meta?.department ?? parts.department;
  const hat = meta?.hat ?? null;
  const date = parsed?.date ?? (meta ? meta.createdAt.slice(0, 10) : null);

  const backHref = project ? projectHref(`vault:${project}`) : "#/";
  const back = <a className="back" href={backHref}>← {project ?? "Empresa"}</a>;

  if (redirectTo || (fromReady && !all && !list.error)) return <div className="empty">Abriendo el documento…</div>;
  if (file.error && !file.data) {
    if (/404/.test(file.error)) {
      return (
        <div className="empty">
          <p>Ese documento ya no está en el vault.</p>
          <p>{back}</p>
        </div>
      );
    }
    return (
      <div className="empty">
        <p>No se pudo abrir el documento: {file.error}</p>
        <p>
          <button type="button" className="btn btn-inline" onClick={() => setAttempt((n) => n + 1)}>
            Reintentar
          </button>
        </p>
      </div>
    );
  }
  if (!parsed || content === null) return <div className="empty">Abriendo el documento…</div>;
  if (!content.trim()) {
    return (
      <div className="empty">
        <p>Este archivo está vacío.</p>
        <p>{back}</p>
      </div>
    );
  }

  const title = parsed.title ?? meta?.title ?? basename(path);
  const isMd = /\.md$/i.test(path);
  const sections = isMd ? splitSections(parsed.body) : [];
  const h2s = sections.filter((s) => s.heading);
  const showToc = unreviewed && h2s.length >= 4;
  const toc = (
    <ol>
      {h2s.map((s) => (
        <li key={s.heading}>
          <a href={`#${headingId(s.heading)}`} onClick={(e) => jump(e, headingId(s.heading))}>
            {nodeText(s.heading)}
          </a>
        </li>
      ))}
    </ol>
  );

  return (
    <article className="reader">
      <div className="reader-back">{back}</div>
      <aside className="reader-side" aria-label="Datos del documento">
        <dl className="reader-meta">
          <div>
            <dt className="sr-only">Autor</dt>
            <dd className="reader-hat">{hat ? HAT_LABEL(hat) : TYPE_LABEL[type]}</dd>
          </div>
          {dept && <div><dt className="sr-only">Departamento</dt><dd>{cap(dept)}</dd></div>}
          {date && <div><dt className="sr-only">Fecha</dt><dd>{date}</dd></div>}
        </dl>
        <nav className="reader-links" aria-label="Documentos relacionados">
          <Access
            href={fullLink ? deliverableHref(fullLink) : null}
            exists={fullExists}
            label="Informe completo"
            off={fullLink ? "Informe no encontrado en el vault" : type === "informe" ? "Estás en el informe" : "Sin informe completo"}
          />
          <Access
            href={reviewPath ? deliverableHref(reviewPath) : null}
            exists={reviewExists}
            label="Revisión de calidad"
            off={reviewPath ? "Revisión no encontrada en el vault" : "Sin revisión"}
          />
          <Access href={sessionId ? `#/s/${sessionId}` : null} label="Ver sesión del agente" off="Sesión no disponible" />
        </nav>
        {showToc && (
          <nav className="reader-toc reader-toc-side" aria-label="Contenido">
            <h2 className="col-label">Contenido</h2>
            {toc}
          </nav>
        )}
      </aside>

      <header className="reader-head">
        {unreviewed && (
          <div className="banner-unreviewed" role="note">
            <b>SIN REVISAR</b>
            <span>Este es el informe del agente tal cual. No tiene resumen para dirección ni revisión de calidad, y puede tener errores.</span>
          </div>
        )}
        <h1 className="reader-title">{title}</h1>
        <p className="reader-sub">
          {[TYPE_LABEL[type], date, meta && timeAgo(meta.at, now)].filter(Boolean).join(" · ")}
          {updatedAt && now - updatedAt < 60_000 && <span className="reader-updated"> · Actualizado hace un momento</span>}
        </p>
        {verdict && <ReviewBadge verdict={verdict} />}
      </header>

      <div className="reader-body">
        {showToc && (
          <details className="reader-toc reader-toc-phone">
            <summary>Contenido</summary>
            {toc}
          </details>
        )}
        <div>
          {isMd ? (
            sections.map((s, i) =>
              isDecideHeading(s.heading) ? (
                <div key={i} className={`decide ${hasPendingDecision(s.md) ? "" : "decide-done"}`}>
                  <Markdown md={s.md} docPath={path} />
                  <p className="decide-foot">
                    Solo lectura. Para decidir, díselo al agente en su sesión.{" "}
                    {sessionId ? <a href={`#/s/${sessionId}`}>Ver sesión del agente</a> : <span className="muted">Sesión no disponible</span>}
                  </p>
                </div>
              ) : (
                <Markdown key={i} md={s.md} docPath={path} />
              ),
            )
          ) : (
            <pre className="reader-raw">{parsed.body}</pre>
          )}
          {truncated && <p className="reader-trunc">Documento muy largo: ver completo en el vault.</p>}
        </div>
      </div>
    </article>
  );
}

/** The hash router owns location.hash, so in-page jumps scroll by hand. */
function jump(e: React.MouseEvent, id: string) {
  e.preventDefault();
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
