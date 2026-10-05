import type { DB } from "./db.ts";
import type { HookRecord } from "./hooks.ts";

/**
 * Tope de llamadas hecho cumplir desde fuera. Los agentes cuentan de menos sus llamadas (3c: dijo ~31,
 * fueron 56 con tope 35), asi que el servidor cuenta los PreToolUse reales de cada subagente y, al pasar
 * el tope, contesta al hook con `deny`. Solo subagentes (agent_id) con tope conocido; la sesion principal
 * nunca se limita. Si el servidor esta caido el hook falla abierto: nunca bloquea por error.
 *
 * Tope = el del prompt del Agent si empieza con "Tope: N llamadas" (lo pone el brief), si no el del HAT.
 * Pasado el tope quedan GRACE llamadas solo para escribir (Write/Edit) y guardar el entregable.
 */
export const GRACE = 5;
export const WARN_BEFORE = 5;
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** Entregar el informe final nunca se niega: es justo lo que el tope pide hacer. */
const ALWAYS_ALLOWED = new Set(["SubagentHandback"]);
const PROMPT_CAP_RE = /tope:?\s*(\d{1,3})\s*llamadas/i;

export function parsePromptCap(prompt: string | null | undefined): number | null {
  const m = prompt ? PROMPT_CAP_RE.exec(prompt) : null;
  const n = m ? Number(m[1]) : NaN;
  return n > 0 ? n : null;
}

export type CapResponse = { hookSpecificOutput: Record<string, string> };

export function effectiveCap(db: DB, rec: HookRecord, hatCaps: Map<string, number> | undefined): number | null {
  if (!rec.agentId) return null;
  const row = db
    .prepare("SELECT summary FROM events WHERE agent_id = ? AND kind = 'prompt' ORDER BY ts LIMIT 1")
    .get(`${rec.sessionId}/agent-${rec.agentId}`) as { summary: string } | undefined;
  return parsePromptCap(row?.summary) ?? (rec.agentType ? hatCaps?.get(rec.agentType) ?? null : null);
}

/** Llamar DESPUES de recordHook (la llamada actual ya cuenta). Null = no decir nada (permitir normal). */
export function capDecision(db: DB, rec: HookRecord, hatCaps: Map<string, number> | undefined): CapResponse | null {
  if (rec.event !== "PreToolUse" || !rec.agentId || (rec.toolName && ALWAYS_ALLOWED.has(rec.toolName))) return null;
  const cap = effectiveCap(db, rec, hatCaps);
  if (!cap) return null;
  const used = (
    db
      .prepare("SELECT COUNT(*) AS n FROM hook_events WHERE session_id = ? AND agent_id = ? AND event = 'PreToolUse'")
      .get(rec.sessionId, rec.agentId) as { n: number }
  ).n;
  if (used <= cap) {
    if (used !== cap - WARN_BEFORE + 1) return null;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: `Company OS: llevas ${used} de ${cap} llamadas. Cierra ya: guarda el entregable y entrega con pendientes.`,
      },
    };
  }
  if (rec.toolName && WRITE_TOOLS.has(rec.toolName) && used <= cap + GRACE) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `Company OS: tope de ${cap} llamadas alcanzado (esta seria la ${used}). No hagas más llamadas salvo ` +
        `Write/Edit para guardar el entregable (quedan ${Math.max(0, cap + GRACE - used)}). Entrega ahora lo que tengas con la lista de pendientes.`,
    },
  };
}
