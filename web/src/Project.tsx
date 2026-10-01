import { useState } from "react";
import { useLive, useNow, type DepartmentDetail, type ProjectDetail, type SessionView, type VaultEntry } from "./api.ts";
import { STATUS_LABEL, fmtNum, freshTokens, plural, timeAgo } from "./format.ts";
import { Room, deptCode } from "./Office.tsx";

export function Project({ projectKey }: { projectKey: string }) {
  const { data, error } = useLive<ProjectDetail>(`/api/projects/${encodeURIComponent(projectKey)}`);
  const now = useNow();

  if (error && !data) return <div className="empty">No se pudo abrir la sala: {error}</div>;
  if (!data) return <div className="empty">Abriendo la sala…</div>;

  const { project: p, departments } = data;
  const sessions = departments.flatMap((d) => d.sessionList);

  return (
    <>
      <a className="back" href="#/">← Oficina</a>
      <div className="page-head">
        <h1 className="page-title">{p.name}</h1>
        <p className="muted">
          {STATUS_LABEL[p.status]} · {plural(sessions.length, "sesión", "sesiones")} · {fmtNum(freshTokens(p.tokensToday))} tokens hoy
        </p>
      </div>

      <Room name="Sala" departments={departments} sessions={sessions} now={now} meta={timeAgo(p.lastEventAt, now)} />

      {!p.mapped && (
        <p className="hint">
          Este proyecto no tiene ficha en el vault. Copia <span className="mono">_empresa/plantillas/PROYECTO.md</span> a{" "}
          <span className="mono">Proyectos/&lt;nombre&gt;/PROYECTO.md</span> con su <span className="mono">repo_path</span> para
          ver aquí los entregables de cada departamento.
        </p>
      )}

      <h2 className="section-label">Departamentos</h2>
      <div className="registry">
        {departments.map((d) => (
          <DeptRow key={d.slug} d={d} now={now} mapped={p.mapped} />
        ))}
      </div>
    </>
  );
}

function DeptRow({ d, now, mapped }: { d: DepartmentDetail; now: number; mapped: boolean }) {
  return (
    <section className={`reg-row ${d.sessions || d.files.length ? "" : "reg-empty"}`} aria-label={d.name}>
      <div className="reg-dept">
        <span className="plate">{deptCode(d.name)}</span>
        <span className="reg-name">{d.name}</span>
      </div>
      <div className="reg-col">
        <h3 className="col-label">Sesiones</h3>
        {d.sessionList.length === 0 ? (
          <p className="muted small">Ninguna todavía.</p>
        ) : (
          <ul className="plain-list">
            {d.sessionList.slice(0, 5).map((s) => (
              <SessionLine key={s.id} s={s} now={now} />
            ))}
            {d.sessionList.length > 5 && <li className="muted small">y {d.sessionList.length - 5} más</li>}
          </ul>
        )}
      </div>
      {mapped && (
        <div className="reg-col">
          <h3 className="col-label">Entregables en el vault</h3>
          {d.files.length === 0 ? (
            <p className="muted small">Carpeta vacía.</p>
          ) : (
            <ul className="plain-list">
              {d.files.slice(0, 10).map((f) => (
                <VaultItem key={f.path} f={f} now={now} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function SessionLine({ s, now }: { s: SessionView; now: number }) {
  return (
    <li>
      <a className="line-link" href={`#/s/${s.id}`}>
        <span className={`state state-${s.status}`} aria-label={STATUS_LABEL[s.status]} />
        <span className="ellipsis">{s.title ?? "Sesión sin título"}</span>
        <span className="muted small nowrap">{timeAgo(s.lastEventAt, now)}</span>
      </a>
    </li>
  );
}

const TEXT = /\.(md|txt|json|csv|ya?ml)$/i;

function VaultItem({ f, now }: { f: VaultEntry; now: number }) {
  if (f.kind === "dir") {
    return (
      <li>
        <span className="line-link">
          <span className="file-kind">DIR</span>
          <span className="ellipsis">{f.name}</span>
          <span className="muted small nowrap">{timeAgo(f.mtime, now)}</span>
        </span>
        {f.children && f.children.length > 0 && (
          <ul className="plain-list nested">
            {f.children.slice(0, 8).map((c) => (
              <VaultItem key={c.path} f={c} now={now} />
            ))}
          </ul>
        )}
      </li>
    );
  }
  return <FileLine f={f} now={now} />;
}

/** Text files expand inline (no modal): the preview sits right under the file it belongs to. */
function FileLine({ f, now }: { f: VaultEntry; now: number }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const readable = TEXT.test(f.name);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && content === null) {
      try {
        const r = await fetch(`/api/vault/file?path=${encodeURIComponent(f.path)}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setContent(((await r.json()) as { content: string }).content);
      } catch (err) {
        setContent(`No se pudo abrir: ${String(err)}`);
      }
    }
  };

  return (
    <li>
      <button className="line-link" disabled={!readable} aria-expanded={readable ? open : undefined} onClick={toggle}>
        <span className="file-kind">{readable ? (open ? "▾" : "▸") : "BIN"}</span>
        <span className="ellipsis">{f.name}</span>
        <span className="muted small nowrap">{timeAgo(f.mtime, now)}</span>
      </button>
      {open && <pre className="preview">{content ?? "Cargando…"}</pre>}
    </li>
  );
}
