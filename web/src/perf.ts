import type { AgentPerformance } from "./api.ts";

/** Pure formatting for the performance table (no React: tested from tests/). */

const nf = new Intl.NumberFormat("en-US");
const nf1 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** 70 -> "70", 1234567 -> "1,234,567" (thousands separator). */
export const fmtInt = (n: number) => nf.format(Math.round(n));

/** Tokens in k with one decimal: 189341 -> "189.3k". Small numbers stay as they are. */
export function fmtK(n: number): string {
  if (n < 100) return String(Math.round(n));
  return `${nf1.format(n / 1000)}k`;
}

/** 638568 -> "10 min 39 s", 4460733 -> "1 h 14 min", null -> "—". */
export function fmtDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export interface TokenCell {
  /** Text to show, "≈ 12.3k" when approximate. */
  text: string;
  approx: boolean;
  /** Full title: exact number or the explanation of the approximation. */
  title: string;
}

/**
 * Exact `reportedTokens` when Claude Code gave one; otherwise an approximation (new context + approximate
 * output, cache reads excluded) marked with "≈".
 */
export function tokenCell(p: Pick<AgentPerformance, "reportedTokens" | "newContext" | "outputApprox">): TokenCell {
  if (p.reportedTokens !== null) {
    return { text: fmtK(p.reportedTokens), approx: false, title: `${fmtInt(p.reportedTokens)} tokens (cifra exacta reportada por Claude Code)` };
  }
  const n = p.newContext + p.outputApprox;
  return {
    text: `≈ ${fmtK(n)}`,
    approx: true,
    title: `Aproximado: ${fmtInt(n)} tokens (contexto nuevo + salida estimada). Claude Code no reporta la cifra exacta de este agente.`,
  };
}

export const isOverCap = (p: Pick<AgentPerformance, "toolCalls" | "toolCap">) => p.toolCap !== null && p.toolCalls > p.toolCap;

type TokenParts = Pick<AgentPerformance, "reportedTokens" | "newContext" | "outputApprox">;

/**
 * Session total over every row: exact figures plus the approximation of the agents that have no exact figure
 * (the main agent). With any approximation the total is marked "≈" and says so; otherwise it is exact.
 */
export function totalTokenCell(rows: TokenParts[]): TokenCell {
  let exact = 0;
  let approx = 0;
  let approxAgents = 0;
  for (const p of rows) {
    if (p.reportedTokens !== null) exact += p.reportedTokens;
    else {
      approx += p.newContext + p.outputApprox;
      approxAgents++;
    }
  }
  if (approxAgents === 0) return { text: fmtK(exact), approx: false, title: `${fmtInt(exact)} tokens (suma de cifras exactas reportadas por Claude Code)` };
  const n = exact + approx;
  return {
    text: `≈ ${fmtK(n)}`,
    approx: true,
    title: `Incluye cifras aproximadas: ${fmtInt(n)} tokens = ${fmtInt(exact)} exactos (subagentes) + ≈ ${fmtInt(approx)} aproximados (${approxAgents === 1 ? "1 agente" : `${approxAgents} agentes`} sin cifra exacta, p. ej. el principal).`,
  };
}
