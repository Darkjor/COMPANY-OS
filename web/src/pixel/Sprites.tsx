import type { ReactElement, ReactNode } from "react";
import type { Status } from "../api.ts";
import { modelTier } from "../format.ts";

/**
 * Pixel sprites drawn from character grids. Every pose maps to a real agent state:
 * working = typing at a lit monitor, waiting = hand raised + "!" bubble, error = "×" bubble.
 */

type Palette = Record<string, string>;

// 12 × 12 worker seated behind the desk (the desk sprite covers the lower body).
const SEATED = [
  "............",
  "....hhhh....",
  "...hhhhhh...",
  "...hssssh...",
  "...sesses...",
  "...ssssss...",
  "....ssss....",
  "..bbbbbbbb..",
  ".bbbbbbbbbb.",
  ".bbbbbbbbbb.",
  ".bbbbbbbbbb.",
  ".bbbbbbbbbb.",
];

const HAND_UP = [
  "..........s.",
  "....hhhh..s.",
  "...hhhhhh.s.",
  "...hssssh.b.",
  "...sesses.b.",
  "...ssssss.b.",
  "....ssss..b.",
  "..bbbbbbbbb.",
  ".bbbbbbbbbb.",
  ".bbbbbbbbbb.",
  ".bbbbbbbbbb.",
  ".bbbbbbbbbb.",
];

// 18 × 8 desk seen from the front: the monitor's back sits on the left, its glow ("g") spills up when on.
const DESK = [
  "gggggg............",
  "kkkkkk............",
  "kkkkkk............",
  "kkkkkk............",
  "..kk..............",
  "dddddddddddddddddd",
  "dDDDDDDDDDDDDDDDDd",
  ".d..............d.",
];

// 5 × 5 subagent drone.
const DRONE = [".ccc.", "cwcwc", "ccccc", ".c.c.", "c...c"];

const SKIN = ["oklch(0.80 0.06 60)", "oklch(0.68 0.08 55)", "oklch(0.55 0.08 50)", "oklch(0.42 0.06 45)"];
const HAIR = ["oklch(0.30 0.03 50)", "oklch(0.22 0.01 60)", "oklch(0.55 0.10 50)", "oklch(0.72 0.09 85)", "oklch(0.40 0.08 30)"];

export const SHIRT: Record<ReturnType<typeof modelTier>, string> = {
  opus: "oklch(0.64 0.11 305)",
  sonnet: "oklch(0.64 0.09 225)",
  haiku: "oklch(0.68 0.09 150)",
  other: "oklch(0.58 0.03 70)",
};

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Collapse each row into horizontal runs → far fewer <rect>s than one per pixel. */
function Pixels({ grid, palette }: { grid: string[]; palette: Palette }) {
  const rects: ReactElement[] = [];
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let w = 1;
      while (x + w < row.length && row[x + w] === ch) w++;
      if (ch !== "." && palette[ch]) rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={w} height={1} fill={palette[ch]} />);
      x += w;
    }
  });
  return <>{rects}</>;
}

function Svg({ w, h, scale, className, label, children }: { w: number; h: number; scale: number; className?: string; label?: string; children: ReactNode }) {
  return (
    <svg
      className={className}
      viewBox={`0 0 ${w} ${h}`}
      width={w * scale}
      height={h * scale}
      shapeRendering="crispEdges"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {children}
    </svg>
  );
}

export function Worker({ seed, model, status, scale = 4, label }: { seed: string; model: string | null; status: Status; scale?: number; label?: string }) {
  const h = hash(seed);
  const palette: Palette = {
    h: HAIR[h % HAIR.length],
    s: SKIN[(h >>> 4) % SKIN.length],
    e: "oklch(0.20 0.01 60)",
    b: SHIRT[modelTier(model)],
  };
  const grid = status === "waiting" ? HAND_UP : SEATED;
  return (
    <span className={`worker-sprite pose-${status}`}>
      <Svg w={12} h={12} scale={scale} label={label}>
        <Pixels grid={grid} palette={palette} />
      </Svg>
      {(status === "waiting" || status === "error") && (
        <span className={`bubble bubble-${status}`} aria-hidden>
          {status === "waiting" ? "!" : "×"}
        </span>
      )}
    </span>
  );
}

export function Desk({ lit, scale = 4 }: { lit: boolean; scale?: number }) {
  const palette: Palette = {
    k: "oklch(0.32 0.012 60)",
    g: lit ? "oklch(0.80 0.12 175)" : "transparent",
    d: "oklch(0.42 0.045 55)",
    D: "oklch(0.50 0.055 60)",
  };
  return (
    <span className={`desk-sprite ${lit ? "desk-lit" : ""}`}>
      <Svg w={18} h={8} scale={scale}>
        <Pixels grid={DESK} palette={palette} />
      </Svg>
    </span>
  );
}

export function Drone({ scale = 3 }: { scale?: number }) {
  return (
    <span className="drone-sprite">
      <Svg w={5} h={5} scale={scale} label="subagente">
        <Pixels grid={DRONE} palette={{ c: "oklch(0.78 0.09 230)", w: "oklch(0.95 0.02 230)" }} />
      </Svg>
    </span>
  );
}
