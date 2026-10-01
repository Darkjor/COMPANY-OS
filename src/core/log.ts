/** Console logger keeping the [OK]/[WARN]/[ERROR] prefixes inherited from ai-orch. */
export const log = {
  ok: (msg: string) => console.log(`[OK] ${msg}`),
  info: (msg: string) => console.log(msg),
  warn: (msg: string) => console.warn(`[WARN] ${msg}`),
  error: (msg: string) => console.error(`[ERROR] ${msg}`),
};
