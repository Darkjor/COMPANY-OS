import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { log } from "./log.ts";

export interface Department {
  slug: string;
  name: string;
  icon: string;
  keywords: string[];
}

/** Built-in defaults; any `_empresa/departamentos/<slug>.md` in the vault overrides or adds. */
const DEFAULTS: Department[] = [
  { slug: "direccion", name: "Dirección", icon: "🧭", keywords: ["plan", "roadmap", "estrategia", "prioridades", "propuesta", "presupuesto", "cotizacion", "pivot", "vision", "objetivos"] },
  { slug: "desarrollo", name: "Desarrollo", icon: "💻", keywords: ["endpoint", "api", "bug", "fix", "refactor", "deploy", "test", "tests", "supabase", "migracion", "componente", "backend", "frontend", "codigo", "build", "typescript", "react", "next", "database", "rama"] },
  { slug: "diseno", name: "Diseño", icon: "🎨", keywords: ["diseno", "rediseno", "ui", "ux", "uiux", "logo", "branding", "marca", "banner", "figma", "maqueta", "mockup", "paleta", "tipografia"] },
  { slug: "marketing", name: "Marketing", icon: "📣", keywords: ["marketing", "campana", "copy", "copys", "carrusel", "ads", "anuncio", "anuncios", "seo", "redes", "instagram", "facebook", "tiktok", "contenido", "publicidad", "ga4", "gtm", "posicionamiento"] },
  { slug: "research", name: "Research", icon: "🔬", keywords: ["analisis", "investigacion", "research", "competencia", "mercado", "viabilidad", "benchmark", "auditoria", "estudio"] },
];

export const FALLBACK_DEPT = "desarrollo";

export function normalize(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function field(text: string, name: string): string | null {
  return new RegExp(`^\\s*${name}:\\s*(.+)$`, "im").exec(text)?.[1]?.trim() ?? null;
}

export function loadDepartments(vaultDir: string): Department[] {
  const byslug = new Map(DEFAULTS.map((d) => [d.slug, { ...d }]));
  const dir = join(vaultDir, "_empresa", "departamentos");
  if (existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md")) continue;
      const slug = basename(file, ".md");
      try {
        const text = readFileSync(join(dir, file), "utf8");
        const base = byslug.get(slug) ?? { slug, name: slug, icon: "📁", keywords: [] };
        const kw = field(text, "palabras");
        byslug.set(slug, {
          slug,
          name: field(text, "nombre") ?? /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? base.name,
          icon: field(text, "icono") ?? base.icon,
          keywords: kw ? kw.split(",").map((k) => normalize(k.trim())).filter(Boolean) : base.keywords,
        });
      } catch (err) {
        log.warn(`departamento ilegible ${file}: ${String(err)}`);
      }
    }
  }
  return [...byslug.values()];
}

/** Score text against each department's keywords (whole-word match, accent-insensitive). */
export function matchDepartment(text: string | null, departments: Department[]): string | null {
  if (!text) return null;
  const words = ` ${normalize(text).replace(/[^a-z0-9ñ]+/g, " ")} `;
  let best: { slug: string; score: number } | null = null;
  for (const d of departments) {
    let score = 0;
    for (const k of d.keywords) if (words.includes(` ${k} `)) score++;
    if (score > 0 && (!best || score > best.score)) best = { slug: d.slug, score };
  }
  return best?.slug ?? null;
}

const normPath = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/**
 * 1. Session opened inside `<vault>/Proyectos/<slug>/<dept>/…` → that department.
 * 2. Keywords in the session title (or a subagent's name/description).
 * 3. Fallback: desarrollo (sessions run inside code repos).
 */
export function classifySession(
  cwd: string | null,
  title: string | null,
  vaultDir: string,
  departments: Department[],
): string {
  if (cwd) {
    const c = normPath(cwd);
    const v = normPath(vaultDir);
    if (c.startsWith(v + "/")) {
      const segs = c.slice(v.length + 1).split("/");
      if (segs[0] === "proyectos" && segs[2] && departments.some((d) => d.slug === segs[2])) return segs[2];
    }
  }
  return matchDepartment(title, departments) ?? FALLBACK_DEPT;
}
