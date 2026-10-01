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

/** Status thresholds (ms). */
export const WORKING_WINDOW_MS = 60_000;
export const IDLE_AFTER_MS = 10 * 60_000;
