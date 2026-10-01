import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MANAGED_MARKER, hatDepartments, installHats, loadHats, parseHat, toAgentFile } from "../src/core/hats.ts";

const DEFAULTS = join(import.meta.dirname, "..", "hats");

const sample = `---
name: copywriter
description: Escribe textos de marketing.
model: sonnet
tools: Read, Write
departamento: marketing
---

Eres el copywriter.
`;

describe("parseHat", () => {
  it("reads frontmatter and body", () => {
    expect(parseHat(sample, "x.md")).toMatchObject({
      name: "copywriter",
      model: "sonnet",
      tools: "Read, Write",
      department: "marketing",
      body: "Eres el copywriter.",
    });
  });

  it("rejects files without description or with an invalid name", () => {
    expect(parseHat("---\nname: x\n---\nhola", "x.md")).toBeNull();
    expect(parseHat("---\nname: Mal Nombre\ndescription: d\n---\n", "x.md")).toBeNull();
    expect(parseHat("sin frontmatter", "x.md")).toBeNull();
  });
});

describe("toAgentFile", () => {
  it("keeps only Claude Code keys and marks the file as managed", () => {
    const out = toAgentFile(parseHat(sample, "x.md")!);
    expect(out).toContain("name: copywriter");
    expect(out).toContain("tools: Read, Write");
    expect(out).not.toContain("departamento:");
    expect(out).toContain(MANAGED_MARKER);
    expect(out.startsWith("---\n")).toBe(true);
  });
});

describe("default HAT library", () => {
  it("every bundled HAT parses and belongs to a known department", () => {
    const hats = loadHats(DEFAULTS);
    expect(hats.length).toBeGreaterThanOrEqual(9);
    const known = new Set(["direccion", "desarrollo", "diseno", "marketing", "research"]);
    for (const h of hats) expect(known.has(h.department ?? "")).toBe(true);
  });
});

describe("installHats", () => {
  it("seeds the vault, installs agents, and never clobbers a hand-written agent", () => {
    const root = mkdtempSync(join(tmpdir(), "cos-hats-"));
    const vault = join(root, "vault-hats");
    const agents = join(root, "agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "copywriter.md"), "---\nname: copywriter\ndescription: mío\n---\nhecho a mano\n");

    const r = installHats(DEFAULTS, vault, agents);
    expect(r.seeded.length).toBe(readdirSync(DEFAULTS).filter((f) => f.endsWith(".md")).length);
    expect(r.skipped).toEqual(["copywriter"]);
    expect(readFileSync(join(agents, "copywriter.md"), "utf8")).toContain("hecho a mano");
    expect(existsSync(join(agents, "dev-backend.md"))).toBe(true);

    // Editing the vault HAT and reinstalling updates the managed agent file.
    const vaultFile = join(vault, "dev-backend.md");
    writeFileSync(vaultFile, readFileSync(vaultFile, "utf8").replace("model: sonnet", "model: opus"));
    const again = installHats(DEFAULTS, vault, agents);
    expect(again.seeded).toEqual([]);
    expect(readFileSync(join(agents, "dev-backend.md"), "utf8")).toContain("model: opus");

    expect(hatDepartments(vault).get("estratega-seo")).toBe("marketing");
  });
});
