import type { Status, Tokens } from "./api.ts";

export const STATUS_LABEL: Record<Status, string> = {
  working: "Trabajando",
  subagents: "Con subagentes",
  waiting: "Esperando",
  error: "Error",
  idle: "Inactivo",
  done: "Terminado",
};

export function timeAgo(iso: string | null, now: number): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 10) return "ahora";
  if (s < 60) return `hace ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-MX", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

export function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** "Fresh" tokens = what the model really processed (cache reads are cheap and shown apart). */
export const freshTokens = (t: Tokens) => t.input + t.output + t.cacheCreate;

export function modelTier(model: string | null): "opus" | "sonnet" | "haiku" | "other" {
  const m = (model ?? "").toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return "other";
}

export function modelLabel(model: string | null): string {
  if (!model) return "—";
  const m = /claude-(opus|sonnet|haiku|fable)-([\d-]+)/i.exec(model);
  if (!m) return model;
  const ver = m[2].split("-").filter((x) => x.length <= 2).join(".");
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${ver}`;
}

export function agentGlyph(agentType: string | null, kind: "main" | "subagent"): string {
  if (kind === "main") return "◆";
  const t = (agentType ?? "").toLowerCase();
  if (t.includes("explore")) return "⌕";
  if (t.includes("plan")) return "▤";
  if (t.includes("review") || t.includes("qa") || t.includes("test")) return "✓";
  if (t.includes("research")) return "◎";
  if (t.includes("design") || t.includes("ui")) return "✎";
  return "●";
}

export function agentLabel(a: { kind: "main" | "subagent"; name: string | null; agentType: string | null }): string {
  if (a.kind === "main") return "Claude (principal)";
  return a.name ?? a.agentType ?? "subagente";
}

export function shortPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.length > 3 ? "…/" + parts.slice(-3).join("/") : p;
}
