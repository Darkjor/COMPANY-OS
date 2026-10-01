import { useEffect, useState } from "react";
import { useLive, useNow, type DepartmentDetail, type ProjectDetail, type SessionView, type VaultEntry } from "./api.ts";
import { STATUS_LABEL, fmtNum, freshTokens, modelLabel, modelTier, timeAgo } from "./format.ts";

const LIVE = new Set(["working", "subagents", "waiting", "error"]);

export function Project({ projectKey }: { projectKey: string }) {
  const { data, error } = useLive<ProjectDetail>(`/api/projects/${encodeURIComponent(projectKey)}`);
  const now = useNow();
  const [open, setOpen] = useState<string | null>(null);

  if (error && !data) return <div className="empty">No se pudo cargar el proyecto: {error}</div>;
  if (!data) return <div className="empty">Cargando oficina…</div>;

  const { project: p, departments } = data;
  const total = departments.reduce((n, d) => n + d.sessions, 0);

  return (
    <>
      <a className="back" href="#/">← Empresa</a>
      <header className="detail-head">
        <span className={`dot dot-lg dot-${p.status}`} />
        <div>
          <div className="crumb">Oficina del proyecto</div>
          <h1>{p.name}</h1>
          <div className="muted">
            {STATUS_LABEL[p.status]} · {total} sesiones · hoy {fmtNum(freshTokens(p.tokensToday))} tokens
            {data.vaultDir ? <> · vault: <span className="mono">{data.vaultDir}</span></> : " · sin ficha en el vault"}
          </div>
        </div>
      </header>

      {!p.mapped && (
        <div className="notice">
          Este proyecto aún no tiene ficha en el vault. Crea <span className="mono">Proyectos/&lt;nombre&gt;/PROYECTO.md</span> con
          su <span className="mono">repo_path</span> (plantilla en <span className="mono">_empresa/plantillas/</span>) para ver
          aquí los entregables de cada departamento.
        </div>
      )}

      <section className="office">
        {departments.map((d) => (
          <DeptRoom key={d.slug} d={d} now={now} mapped={p.mapped} onOpenFile={setOpen} />
        ))}
      </section>

      {open && <FileViewer path={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function DeptRoom({
  d,
  now,
  mapped,
  onOpenFile,
}: {
  d: DepartmentDetail;
  now: number;
  mapped: boolean;
  onOpenFile: (p: string) => void;
}) {
  const live = d.sessionList.filter((s) => LIVE.has(s.status));
  const recent = d.sessionList.filter((s) => !LIVE.has(s.status)).slice(0, 4);
  const empty = d.sessions === 0 && d.files.length === 0;
  return (
    <article className={`dept room-${d.sessions ? d.status : "idle"} ${empty ? "dept-empty" : ""}`}>
      <header className="dept-head">
        <span className="dept-icon">{d.icon}</span>
        <h2>{d.name}</h2>
        <span className="room-meta">{d.sessions} sesiones</span>
      </header>

      <div className="floor">
        {live.length === 0 ? (
          <span className="muted small">Nadie trabajando ahora</span>
        ) : (
          live.map((s) => <Worker key={s.id} s={s} />)
        )}
      </div>

      {recent.length > 0 && (
        <>
          <h3>Sesiones recientes</h3>
          <ul className="mini-list">
            {recent.map((s) => (
              <li key={s.id}>
                <a href={`#/s/${s.id}`}>
                  <span className={`dot dot-${s.status}`} />
                  <span className="ellipsis">{s.title ?? "Sesión sin título"}</span>
                  <span className="muted small">{timeAgo(s.lastEventAt, now)}</span>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}

      {mapped && (
        <>
          <h3>Entregables en el vault</h3>
          {d.files.length === 0 ? (
            <div className="muted small">Carpeta vacía.</div>
          ) : (
            <ul className="vault-tree">
              {d.files.slice(0, 12).map((f) => (
                <VaultItem key={f.path} f={f} now={now} onOpen={onOpenFile} />
              ))}
            </ul>
          )}
        </>
      )}
    </article>
  );
}

function Worker({ s }: { s: SessionView }) {
  return (
    <a className="worker" href={`#/s/${s.id}`} title={s.current ?? ""}>
      <span className={`avatar avatar-${s.status === "subagents" ? "working" : s.status}`}>◆</span>
      <span className="worker-body">
        <span className="worker-name">
          {s.title ?? "Sesión"}
          <span className={`chip chip-${modelTier(s.model)}`}>{modelLabel(s.model)}</span>
          {s.activeAgents > 1 && <span className="crowd">+{s.activeAgents - 1}</span>}
        </span>
        <span className="worker-doing">{s.status === "waiting" ? "Esperando tu respuesta" : s.current}</span>
      </span>
    </a>
  );
}

const TEXT = /\.(md|txt|json|csv|ya?ml)$/i;

function VaultItem({ f, now, onOpen }: { f: VaultEntry; now: number; onOpen: (p: string) => void }) {
  if (f.kind === "dir") {
    return (
      <li>
        <div className="vault-dir">
          <span>📁 {f.name}</span>
          <span className="muted small">{timeAgo(f.mtime, now)}</span>
        </div>
        {f.children && f.children.length > 0 && (
          <ul className="vault-tree nested">
            {f.children.slice(0, 8).map((c) => (
              <VaultItem key={c.path} f={c} now={now} onOpen={onOpen} />
            ))}
          </ul>
        )}
      </li>
    );
  }
  const readable = TEXT.test(f.name);
  return (
    <li>
      <button className="vault-file" disabled={!readable} onClick={() => onOpen(f.path)}>
        <span>{readable ? "📄" : "🖼"} {f.name}</span>
        <span className="muted small">{timeAgo(f.mtime, now)}</span>
      </button>
    </li>
  );
}

function FileViewer({ path, onClose }: { path: string; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/vault/file?path=${encodeURIComponent(path)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { content: string }) => alive && setContent(j.content))
      .catch((err) => alive && setContent(`No se pudo abrir: ${String(err)}`));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      alive = false;
      window.removeEventListener("keydown", onKey);
    };
  }, [path, onClose]);
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <header>
          <span className="mono">{path}</span>
          <button onClick={onClose}>✕</button>
        </header>
        <pre>{content ?? "Cargando…"}</pre>
      </div>
    </div>
  );
}
