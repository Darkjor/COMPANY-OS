import { Children, isValidElement, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { deliverableHref } from "./api.ts";
import { classifyHref, headingId, looksLikeVaultPath, resolveRelative } from "./readerDoc.ts";

/** Minimal hast shape: just what the table-label plugin touches. */
interface HNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
  value?: string;
}

const hastText = (n: HNode): string => (n.type === "text" ? (n.value ?? "") : (n.children ?? []).map(hastText).join(""));

/** Copies each column header onto its cells as data-label, so phones can stack rows (CSS td::before). */
function rehypeTableLabels() {
  return (tree: HNode) => {
    const visit = (n: HNode) => {
      if (n.type === "element" && n.tagName === "table") {
        const rows = (n.children ?? []).flatMap((c) => (c.type === "element" && (c.tagName === "thead" || c.tagName === "tbody") ? (c.children ?? []) : [c]));
        const cells = (row: HNode) => (row.children ?? []).filter((c) => c.type === "element" && (c.tagName === "th" || c.tagName === "td"));
        const head = rows.find((r) => r.type === "element" && r.tagName === "tr" && cells(r).some((c) => c.tagName === "th"));
        const labels = head ? cells(head).map(hastText) : [];
        for (const row of rows) {
          if (row === head) continue;
          cells(row).forEach((c, i) => {
            if (c.tagName === "td" && labels[i]) c.properties = { ...c.properties, dataLabel: labels[i] };
          });
        }
      }
      (n.children ?? []).forEach(visit);
    };
    visit(tree);
  };
}

/** Plain text of rendered children, for heading ids. */
export function nodeText(children: ReactNode): string {
  return Children.toArray(children)
    .map((c) => (typeof c === "string" || typeof c === "number" ? String(c) : isValidElement<{ children?: ReactNode }>(c) ? nodeText(c.props.children) : ""))
    .join("");
}

function makeComponents(docPath: string): Components {
  return {
    h2: ({ children }) => <h2 id={headingId(nodeText(children))}>{children}</h2>,
    a: ({ href, children }) => {
      const kind = classifyHref(href);
      if (kind === "external") {
        return (
          <a className="ext" href={href} target="_blank" rel="noopener noreferrer" aria-label={`${nodeText(children)} (abre en pestaña nueva)`}>
            {children}
            <span aria-hidden> ↗</span>
          </a>
        );
      }
      if (kind === "internal" && href) {
        const file = href.split("#")[0];
        const target = file.startsWith("Proyectos/") ? file : resolveRelative(docPath, file);
        if (target) return <a href={deliverableHref(target)}>{children}</a>;
      }
      return <span>{children}</span>; // javascript:, data:, anchors… never become links
    },
    img: ({ alt }) => <span className="md-img">{alt ? `[imagen: ${alt}]` : "[imagen]"}</span>,
    code: ({ children, className }) => {
      const text = nodeText(children);
      if (!className && !text.includes("\n") && looksLikeVaultPath(text)) {
        return (
          <a href={deliverableHref(text.replace(/\\/g, "/"))}>
            <code>{children}</code>
          </a>
        );
      }
      return <code className={className}>{children}</code>;
    },
    table: ({ children }) => (
      <div className="table-wrap">
        <table>{children}</table>
      </div>
    ),
    // Task-list boxes are drawn, not <input>: read-only, never focusable (spec §5).
    input: (props: ComponentProps<"input">) =>
      props.type === "checkbox" ? (
        <span className={`cbx ${props.checked ? "cbx-on" : ""}`} role="img" aria-label={props.checked ? "Decidido" : "Pendiente de decidir"} />
      ) : null,
  };
}

/** react-markdown + GFM. No raw HTML: without a rehype-raw plugin, tags in the source stay inert text. */
export function Markdown({ md, docPath }: { md: string; docPath: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeTableLabels]} components={makeComponents(docPath)} urlTransform={(u) => u}>
        {md}
      </ReactMarkdown>
    </div>
  );
}
