import { homedir } from "node:os";
import { join } from "node:path";

/** Where Claude Code writes its session transcripts (read-only source). */
export const CLAUDE_PROJECTS_DIR =
  process.env.COMPANY_OS_CLAUDE_DIR ?? join(homedir(), ".claude", "projects");

/** Company vault (Markdown knowledge base). Owned by us, independent of Anthropic. */
export const VAULT_DIR = process.env.COMPANY_OS_VAULT ?? join(homedir(), "COMPANY OS");

/** SQLite index — rebuildable from the transcripts at any time. */
export const DB_PATH =
  process.env.COMPANY_OS_DB ?? join(import.meta.dirname, "..", "..", "data", "company-os.db");

export const PORT = Number(process.env.COMPANY_OS_PORT ?? 4747);

/** Where HATs are installed as Claude Code user-level subagents (available in every project). */
export const AGENTS_DIR = process.env.COMPANY_OS_AGENTS_DIR ?? join(homedir(), ".claude", "agents");

/** Status thresholds (ms). */
export const WORKING_WINDOW_MS = 60_000;
export const IDLE_AFTER_MS = 10 * 60_000;
/** A finished turn keeps "waiting for you" this long before it is considered abandoned. */
export const WAITING_TTL_MS = Number(process.env.COMPANY_OS_WAITING_TTL_MIN ?? 120) * 60_000;
