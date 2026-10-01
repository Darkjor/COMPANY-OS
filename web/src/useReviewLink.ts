import { useEffect, useState } from "react";
import type { DeliverableType, ReviewVerdict } from "./api.ts";
import { followUpOf, reviewCandidate, reviewVerdictFromDoc } from "./readerDoc.ts";

export interface ReviewLink {
  /** Candidate found but not resolved yet (avoids flashing the SIN REVISAR banner). */
  pending: boolean;
  path: string | null;
  verdict: ReviewVerdict | null;
}

async function readFile(path: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/vault/file?path=${encodeURIComponent(path)}`);
    return res.ok ? ((await res.json()) as { content: string }).content : null;
  } catch {
    return null;
  }
}

/**
 * Finds the review of a report (informe/plan) and reads its verdict. A `revision-seguimiento.md` in the review's
 * folder wins over the original review. A review that cannot be read yields no link.
 */
export function useReviewLink(docPath: string, content: string | null, type: DeliverableType, deliverablePaths: string[] | null): ReviewLink {
  const eligible = (type === "informe" || type === "plan") && content !== null && deliverablePaths !== null;
  const candidate = eligible ? reviewCandidate(docPath, content, deliverablePaths) : null;
  const key = candidate ? `${docPath}|${candidate}` : null;
  const [res, setRes] = useState<{ key: string; path: string | null; verdict: ReviewVerdict | null } | null>(null);

  useEffect(() => {
    if (!candidate || !key) return;
    let alive = true;
    void (async () => {
      const follow = followUpOf(candidate);
      const newer = follow === candidate ? null : await readFile(follow);
      const path = newer !== null ? follow : candidate;
      const md = newer ?? (await readFile(candidate));
      if (alive) setRes({ key, path: md === null ? null : path, verdict: md === null ? null : reviewVerdictFromDoc(md) });
    })();
    return () => {
      alive = false;
    };
  }, [candidate, key]);

  if (!eligible) return { pending: deliverablePaths === null && (type === "informe" || type === "plan"), path: null, verdict: null };
  if (!key) return { pending: false, path: null, verdict: null };
  if (res?.key !== key) return { pending: true, path: null, verdict: null };
  return { pending: false, path: res.path, verdict: res.verdict };
}
