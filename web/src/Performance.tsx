import { deliverableHref, type AgentPerformance, type AgentView } from "./api.ts";
import { agentLabel, plural } from "./format.ts";
import { fmtDuration, fmtInt, fmtK, isOverCap, tokenCell } from "./perf.ts";

const MAX_LINKS = 3;

function Calls({ p }: { p: Pick<AgentPerformance, "toolCalls" | "toolCap"> }) {
  const over = isOverCap(p);
  const pct = p.toolCap ? Math.min(100, Math.round((p.toolCalls / p.toolCap) * 100)) : 0;
  return (
    <span
      className={over ? "perf-over" : undefined}
      title={p.toolCap === null ? "Este agente no tiene tope de llamadas" : over ? `Por encima del tope de ${p.toolCap} llamadas (el tope es una instrucción, no un límite)` : `Tope: ${p.toolCap} llamadas`}
    >
      {over && <span aria-hidden>▲ </span>}
      {fmtInt(p.toolCalls)}
      {p.toolCap !== null && ` / ${fmtInt(p.toolCap)}`}
      {over && <span className="sr-only"> (por encima del tope)</span>}
      {p.toolCap !== null && (
        <span className="perf-bar" aria-hidden>
          <i style={{ width: `${pct}%` }} />
        </span>
      )}
    </span>
  );
}

function Deliverables({ items }: { items: AgentPerformance["deliverables"] }) {
  if (items.length === 0) return <span className="muted">—</span>;
  return (
    <ul className="perf-dels">
      {items.slice(0, MAX_LINKS).map((d) => (
        <li key={d.path}>
          <a href={deliverableHref(d.path)} title={d.path}>
            {d.title}
          </a>
        </li>
      ))}
      {items.length > MAX_LINKS && <li className="muted">+{items.length - MAX_LINKS} más</li>}
    </ul>
  );
}

/** One row per agent (main + subagents) and a session total. Tokens are exact only when Claude Code reported them. */
export function Performance({
  agents,
  total,
  mainHat,
}: {
  agents: AgentView[];
  total: AgentPerformance | undefined;
  mainHat: string | null;
}) {
  const rows = agents.filter((a) => a.performance);
  if (rows.length === 0 || !total) return null;
  const totalTokens = tokenCell(total);
  const anyApprox = rows.some((a) => a.performance && tokenCell(a.performance).approx);
  return (
    <section className="perf" aria-label="Desempeño por agente">
      <h3>Desempeño</h3>
      <div className="perf-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Agente</th>
              <th scope="col">HAT</th>
              <th scope="col" className="perf-num">Tokens</th>
              <th scope="col" className="perf-num">Llamadas</th>
              <th scope="col" className="perf-num">Duración</th>
              <th scope="col">Entregables</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const p = a.performance as AgentPerformance;
              const t = tokenCell(p);
              const hat = a.kind === "main" ? mainHat : a.agentType;
              return (
                <tr key={a.id}>
                  <th scope="row" className="perf-who" data-label="Agente">{agentLabel(a)}</th>
                  <td data-label="HAT">{hat ? <span className="perf-hat">{hat}</span> : <span className="muted">—</span>}</td>
                  <td className={`perf-num ${t.approx ? "perf-approx" : ""}`} data-label="Tokens" title={t.title}>
                    {t.text}
                    {t.approx && <span className="sr-only"> (aproximado)</span>}
                  </td>
                  <td className="perf-num" data-label="Llamadas"><Calls p={p} /></td>
                  <td className="perf-num" data-label="Duración">{fmtDuration(p.durationMs)}</td>
                  <td data-label="Entregables"><Deliverables items={p.deliverables} /></td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="perf-total">
              <th scope="row" className="perf-who" data-label="Agente">Total de la sesión</th>
              <td data-label="HAT"><span className="muted">—</span></td>
              <td
                className={`perf-num ${totalTokens.approx ? "perf-approx" : ""}`}
                data-label="Tokens"
                title={
                  total.reportedTokens !== null
                    ? `${fmtInt(total.reportedTokens)} tokens: suma de los agentes que reportan cifra exacta; el agente principal no entra`
                    : totalTokens.title
                }
              >
                {total.reportedTokens !== null ? fmtK(total.reportedTokens) : totalTokens.text}
              </td>
              <td className="perf-num" data-label="Llamadas">{fmtInt(total.toolCalls)}</td>
              <td className="perf-num" data-label="Duración">{fmtDuration(total.durationMs)}</td>
              <td data-label="Entregables">{total.deliverables.length ? plural(total.deliverables.length, "entregable", "entregables") : <span className="muted">—</span>}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="perf-foot">
        Tokens: cifra exacta cuando Claude Code la reporta; con ≈ es un aproximado (contexto nuevo + salida estimada, sin lecturas de caché)
        {anyApprox ? " y no entra en el total" : ""}. El tope de llamadas es una instrucción al agente, no un límite impuesto.
      </p>
    </section>
  );
}
