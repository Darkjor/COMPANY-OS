/**
 * Pure transcript-line parser. Claude Code's JSONL format is not a public API,
 * so everything here is defensive: unknown shapes are ignored, never thrown.
 */

export type EventKind = "prompt" | "text" | "thinking" | "tool_use" | "tool_result" | "error";

export interface ParsedEvent {
  id: string;
  ts: string;
  kind: EventKind;
  toolName: string | null;
  toolUseId: string | null;
  summary: string;
  filePath: string | null;
  fileOp: "read" | "edit" | "write" | null;
}

export interface ParsedUsage {
  messageId: string;
  ts: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface ParsedLine {
  sessionId: string | null;
  cwd: string | null;
  gitBranch: string | null;
  ts: string | null;
  title: string | null;
  model: string | null;
  /**
   * Who started the turn: "human" for prompts typed in VS Code/CLI, "sdk" for headless runs
   * (claude -p). Note: promptSource is "sdk" for both, so only turnOrigin tells them apart.
   */
  turnOrigin: string | null;
  events: ParsedEvent[];
  usage: ParsedUsage | null;
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*=\s*\S+/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
];

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, name?: string) => (typeof name === "string" ? `${name}=•••` : "•••"));
  }
  return out;
}

export function clip(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

const READ_TOOLS = new Set(["Read", "NotebookRead"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit"]);
const WRITE_TOOLS = new Set(["Write"]);

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Short human label for a tool call: "Edit src/main.py", "Bash npm test", ... */
export function summarizeToolUse(name: string, input: Record<string, unknown>): string {
  const target =
    str(input.file_path) ??
    str(input.notebook_path) ??
    str(input.description) ??
    str(input.command) ??
    str(input.pattern) ??
    str(input.query) ??
    str(input.url) ??
    str(input.path) ??
    str(input.skill) ??
    str(input.prompt) ??
    "";
  return clip(redact(target ? `${name} ${target}` : name));
}

function fileOpFor(name: string): ParsedEvent["fileOp"] {
  if (READ_TOOLS.has(name)) return "read";
  if (EDIT_TOOLS.has(name)) return "edit";
  if (WRITE_TOOLS.has(name)) return "write";
  return null;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""))
      .join(" ");
  }
  return "";
}

function blockEvents(raw: Record<string, unknown>, ts: string, role: string): ParsedEvent[] {
  const uuid = str(raw.uuid);
  const message = raw.message as { content?: unknown } | undefined;
  if (!uuid || !message) return [];
  const content = message.content;

  if (typeof content === "string") {
    if (role !== "user" || raw.isMeta === true) return [];
    return [mk(uuid, 0, ts, "prompt", clip(redact(content)))];
  }
  if (!Array.isArray(content)) return [];

  const out: ParsedEvent[] = [];
  content.forEach((block: unknown, i: number) => {
    if (!block || typeof block !== "object") return;
    const b = block as Record<string, unknown>;
    switch (b.type) {
      case "text": {
        const text = str(b.text);
        if (!text) return;
        out.push(mk(uuid, i, ts, role === "user" ? "prompt" : "text", clip(redact(text))));
        return;
      }
      case "thinking":
        out.push(mk(uuid, i, ts, "thinking", "pensando…"));
        return;
      case "tool_use": {
        const name = str(b.name) ?? "tool";
        const input = (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>;
        const ev = mk(uuid, i, ts, "tool_use", summarizeToolUse(name, input));
        ev.toolName = name;
        ev.toolUseId = str(b.id);
        const op = fileOpFor(name);
        const fp = str(input.file_path) ?? str(input.notebook_path);
        if (op && fp) {
          ev.fileOp = op;
          ev.filePath = fp;
        }
        out.push(ev);
        return;
      }
      case "tool_result": {
        const isError = b.is_error === true;
        const ev = mk(
          uuid,
          i,
          ts,
          isError ? "error" : "tool_result",
          isError ? clip(redact(resultText(b.content))) : "resultado",
        );
        ev.toolUseId = str(b.tool_use_id);
        out.push(ev);
        return;
      }
    }
  });
  return out;
}

function mk(uuid: string, i: number, ts: string, kind: EventKind, summary: string): ParsedEvent {
  return { id: `${uuid}:${i}`, ts, kind, toolName: null, toolUseId: null, summary, filePath: null, fileOp: null };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function parseLine(line: string): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;

  const ts = str(raw.timestamp);
  const parsed: ParsedLine = {
    sessionId: str(raw.sessionId),
    cwd: str(raw.cwd),
    gitBranch: str(raw.gitBranch),
    ts,
    title: raw.type === "ai-title" ? str(raw.aiTitle) : null,
    model: null,
    turnOrigin: raw.type === "user" ? str(raw.turnOrigin) : null,
    events: [],
    usage: null,
  };

  if ((raw.type === "user" || raw.type === "assistant") && ts) {
    parsed.events = blockEvents(raw, ts, raw.type);
  }

  if (raw.type === "assistant" && ts) {
    const m = raw.message as Record<string, unknown> | undefined;
    const model = str(m?.model);
    if (model && model !== "<synthetic>") parsed.model = model;
    const usage = m?.usage as Record<string, unknown> | undefined;
    const messageId = str(m?.id);
    if (usage && messageId && parsed.model) {
      parsed.usage = {
        messageId,
        ts,
        model: parsed.model,
        input: num(usage.input_tokens),
        output: num(usage.output_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        cacheCreate: num(usage.cache_creation_input_tokens),
      };
    }
  }
  return parsed;
}
