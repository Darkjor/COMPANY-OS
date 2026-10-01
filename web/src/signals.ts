import type { Deliverable, SessionView } from "./api.ts";

/** One table for office seats, the "Te necesitan" bar and lists (spec §1). Lower rank = more urgent. */
export type Signal = "error" | "permission" | "question" | "delivered" | "finished";

export const SIGNAL_LABEL: Record<Signal, string> = {
  error: "FALLÓ",
  permission: "PIDE PERMISO",
  question: "TE PREGUNTA",
  delivered: "INFORME LISTO",
  finished: "TERMINÓ",
};

export const SIGNAL_RANK: Record<Signal, number> = { error: 1, permission: 2, question: 3, delivered: 4, finished: 5 };

/** Amber signals mean "blocked without you"; paper (delivered) and OK (finished) never compete with them. */
export const isBlocking = (sig: Signal) => sig !== "delivered";

/** A deliverable is new when it was never seen, or was rewritten after it was seen. */
export function isNewDeliverable(d: Deliverable, locallySeen: (path: string) => boolean): boolean {
  if (locallySeen(d.path)) return false;
  if (!d.seenAt) return true;
  return Date.parse(d.seenAt) < Date.parse(d.at);
}

/** What the session is signalling right now, or null when it is just working/idle. */
export function signalOf(s: SessionView, locallySeen: (path: string) => boolean = () => false): Signal | null {
  if (s.status === "error") return "error";
  // A finished (headless) session keeps its "informe listo" until the human sees it, whatever status it ended in.
  if (s.waitingKind === "delivered" && s.status !== "working" && s.status !== "subagents") {
    return s.deliverable && isNewDeliverable(s.deliverable, locallySeen) ? "delivered" : s.status === "waiting" ? "finished" : null;
  }
  if (s.status !== "waiting") return null;
  switch (s.waitingKind) {
    case "permission":
    case "question":
      return s.waitingKind;
    case "delivered":
      // Seen reports drop to "terminó"; with no deliverable attached it is plain "terminó" too.
      return s.deliverable && isNewDeliverable(s.deliverable, locallySeen) ? "delivered" : "finished";
    default:
      return "finished";
  }
}

export interface CallLike {
  s: SessionView;
  signal: Signal;
}

/** Urgency first; inside a group, whoever has waited longest. */
export function compareCalls(a: CallLike, b: CallLike): number {
  if (a.signal !== b.signal) return SIGNAL_RANK[a.signal] - SIGNAL_RANK[b.signal];
  return (a.s.lastEventAt ?? "").localeCompare(b.s.lastEventAt ?? "");
}

/** Short spoken form for aria-labels: "informe listo". */
export const signalText = (sig: Signal) => SIGNAL_LABEL[sig].toLowerCase();

export const HAT_LABEL = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
