import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface Pos {
  left: number;
  top: number;
  below: boolean;
}

const TIP_W = 240;

/**
 * Hover/focus card for a seat. Rendered in a portal with fixed position because rooms use clip-path,
 * which would cut a tooltip hanging over the top row of seats. Mouse only: touch has no hover.
 */
export function useSeatTip(content: ReactNode) {
  const ref = useRef<HTMLAnchorElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);

  const show = () => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left + r.width / 2 - TIP_W / 2), window.innerWidth - TIP_W - 8);
    // ~110 px is the tallest card; flip below the seat when the top row has no room above.
    const below = r.top < 130;
    setPos({ left, top: below ? r.bottom + 8 : r.top - 8, below });
  };
  const hide = () => setPos(null);

  const handlers = {
    onPointerEnter: (e: React.PointerEvent) => {
      if (e.pointerType === "mouse") show();
    },
    onPointerLeave: hide,
    onFocus: (e: React.FocusEvent) => {
      if (e.currentTarget.matches(":focus-visible")) show();
    },
    onBlur: hide,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Escape") hide();
    },
  };

  const tip =
    pos &&
    createPortal(
      <div
        className={`seat-tip ${pos.below ? "seat-tip-below" : ""}`}
        role="tooltip"
        style={{ left: pos.left, top: pos.top, width: TIP_W }}
      >
        {content}
      </div>,
      document.body,
    );

  return { ref, handlers, tip };
}
