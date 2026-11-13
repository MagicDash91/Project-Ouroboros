"use client";

// Editing pieces for the Auto Dashboard: colour palettes, a small pop-over, the colour menu,
// chart-type glyphs and drag-to-move (native HTML5 drag and drop, plus keyboard-friendly buttons).

import { useEffect, useRef, useState, type ReactNode } from "react";
import { PBI } from "./pbi";

export const PALETTES: { id: string; name: string; colors: string[] }[] = [
  { id: "default", name: "Power BI (default)", colors: [] },
  { id: "ocean", name: "Ocean", colors: ["#0EA5E9", "#0369A1", "#14B8A6", "#6366F1", "#22D3EE", "#1E3A8A", "#5EEAD4", "#818CF8"] },
  { id: "sunset", name: "Sunset", colors: ["#F97316", "#EF4444", "#F59E0B", "#EC4899", "#A855F7", "#FB7185", "#FBBF24", "#7C3AED"] },
  { id: "corporate", name: "Corporate", colors: ["#1E3A8A", "#2563EB", "#64748B", "#0F766E", "#93C5FD", "#334155", "#0EA5E9", "#CBD5E1"] },
  { id: "vibrant", name: "Vibrant", colors: ["#E11D48", "#2563EB", "#16A34A", "#F59E0B", "#9333EA", "#0891B2", "#EA580C", "#DB2777"] },
  { id: "pastel", name: "Pastel", colors: ["#93C5FD", "#FCA5A5", "#86EFAC", "#FDE68A", "#C4B5FD", "#A5F3FC", "#FDBA74", "#F9A8D4"] },
  { id: "earth", name: "Earth", colors: ["#92400E", "#65A30D", "#B45309", "#4D7C0F", "#78350F", "#A16207", "#3F6212", "#854D0E"] },
  { id: "ouroboros", name: "Ouroboros", colors: ["#C8452B", "#181613", "#4F6B4A", "#8FA6B5", "#D9A441", "#B8857F", "#6F6A60", "#E8DFCF"] },
  { id: "mono", name: "Monochrome blue", colors: ["#0B3D91", "#1452B8", "#1F6FE0", "#4B8DF0", "#7AABF5", "#A6C8F9", "#CFE1FC", "#E8F0FE"] },
  // Okabe-Ito: tells colours apart for the most common kinds of colour blindness.
  { id: "colorblind", name: "Colour-blind safe", colors: ["#0072B2", "#E69F00", "#009E73", "#D55E00", "#CC79A7", "#56B4E9", "#F0E442", "#000000"] },
];

export const sameColors = (a: string[] = [], b: string[] = []) =>
  a.length === b.length && a.every((c, i) => c.toLowerCase() === (b[i] || "").toLowerCase());

export function Swatches({ colors, size = 12 }: { colors: string[]; size?: number }) {
  const shown = colors.length ? colors : PBI.palette;
  return (
    <span className="inline-flex shrink-0 overflow-hidden rounded-full" style={{ border: `1px solid ${PBI.border}` }} aria-hidden="true">
      {shown.slice(0, 8).map((c, i) => (
        <span key={i} style={{ background: c, width: size, height: size }} />
      ))}
    </span>
  );
}

/** A small pop-over anchored under its button; closes on an outside click or Escape. */
export function Popover({ label, children, title, align = "left", disabled }: {
  label: ReactNode;
  children: (close: () => void) => ReactNode;
  title?: string;
  align?: "left" | "right";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const out = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", out);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", out);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} title={title} aria-expanded={open} disabled={disabled}
        className="flex items-center gap-1.5 rounded-[2px] px-2 py-1 text-[12px] transition-colors hover:bg-[#EDEBE9] disabled:opacity-40"
        style={{ color: PBI.ink, background: open ? "#EDEBE9" : undefined }}>
        {label}
      </button>
      {open && (
        <div className={`absolute top-full z-30 mt-1 w-[260px] rounded-[4px] bg-white p-2 text-[12px] shadow-[0_8px_24px_rgba(0,0,0,0.16)] ${align === "right" ? "right-0" : "left-0"}`}
          style={{ border: `1px solid ${PBI.border}`, color: PBI.ink }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** Pick colours: a preset or eight custom colours. `inherit` adds a "use the dashboard's colours" choice. */
export function ColorMenu({ value, onChange, inherit, inheritColors, label = "Colours", align }: {
  value: string[];
  onChange: (colors: string[]) => void;
  inherit?: boolean;
  inheritColors?: string[];
  label?: string;
  align?: "left" | "right";
}) {
  const [custom, setCustom] = useState<string[]>([]);
  const shown = value.length ? value : inherit ? inheritColors || [] : [];
  return (
    <Popover align={align} title={label} label={<><Swatches colors={shown} size={9} /> {label}</>}>
      {(close) => (
        <div className="space-y-1">
          {inherit && (
            <button type="button" onClick={() => { onChange([]); close(); }}
              className="flex w-full items-center gap-2 rounded-[2px] px-1.5 py-1 text-left hover:bg-[#F3F2F1]"
              style={!value.length ? { background: "#E8F3FF", fontWeight: 600 } : undefined}>
              <Swatches colors={inheritColors || []} size={10} /> Same as dashboard
            </button>
          )}
          {PALETTES.filter((p) => !inherit || p.colors.length).map((p) => {
            const on = value.length ? sameColors(p.colors, value) : !inherit && !p.colors.length;
            return (
              <button key={p.id} type="button" onClick={() => { onChange(p.colors); close(); }}
                className="flex w-full items-center gap-2 rounded-[2px] px-1.5 py-1 text-left hover:bg-[#F3F2F1]"
                style={on ? { background: "#E8F3FF", fontWeight: 600 } : undefined}>
                <Swatches colors={p.colors} size={10} /> {p.name}
              </button>
            );
          })}
          <div className="border-t pt-2" style={{ borderColor: PBI.border }}>
            <div className="mb-1 text-[11px]" style={{ color: PBI.sub }}>Custom (in series order)</div>
            <div className="flex flex-wrap gap-1">
              {(custom.length ? custom : (shown.length ? shown : PBI.palette).slice(0, 8)).map((c, i, arr) => (
                <input key={i} type="color" value={c} aria-label={`Colour ${i + 1}`}
                  onChange={(e) => { const next = [...arr]; next[i] = e.target.value.toUpperCase(); setCustom(next); }}
                  className="h-6 w-6 cursor-pointer rounded-[2px] border-0 bg-transparent p-0" />
              ))}
            </div>
            <button type="button" disabled={!custom.length} onClick={() => { onChange(custom); setCustom([]); close(); }}
              className="mt-2 w-full rounded-[2px] px-2 py-1 text-[12px] font-semibold text-white disabled:opacity-40"
              style={{ background: PBI.palette[0] }}>
              Apply custom colours
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}

/** 16px glyphs for the chart-type switcher. */
export function TypeGlyph({ type }: { type: string }) {
  const c = "currentColor";
  const g: Record<string, ReactNode> = {
    bar: <><rect x="2" y="8" width="3" height="6" fill={c} /><rect x="6.5" y="4" width="3" height="10" fill={c} /><rect x="11" y="6" width="3" height="8" fill={c} /></>,
    horizontal_bar: <><rect x="2" y="2.5" width="9" height="3" fill={c} /><rect x="2" y="6.5" width="12" height="3" fill={c} /><rect x="2" y="10.5" width="6" height="3" fill={c} /></>,
    stacked_bar: <><rect x="2" y="6" width="3" height="4" fill={c} opacity=".5" /><rect x="2" y="10" width="3" height="4" fill={c} /><rect x="6.5" y="3" width="3" height="5" fill={c} opacity=".5" /><rect x="6.5" y="8" width="3" height="6" fill={c} /><rect x="11" y="7" width="3" height="3" fill={c} opacity=".5" /><rect x="11" y="10" width="3" height="4" fill={c} /></>,
    line: <polyline points="2,12 6,7 9.5,9.5 14,3.5" fill="none" stroke={c} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />,
    area: <><polygon points="2,14 2,11 6,6.5 9.5,9 14,3.5 14,14" fill={c} opacity=".35" /><polyline points="2,11 6,6.5 9.5,9 14,3.5" fill="none" stroke={c} strokeWidth="1.6" strokeLinejoin="round" /></>,
    pie: <><circle cx="8" cy="8" r="5.5" fill="none" stroke={c} strokeWidth="3" opacity=".45" /><path d="M8 2.5 A5.5 5.5 0 0 1 13.5 8" fill="none" stroke={c} strokeWidth="3" /></>,
    table: <><rect x="2" y="3" width="12" height="10" fill="none" stroke={c} strokeWidth="1.3" /><line x1="2" y1="6.5" x2="14" y2="6.5" stroke={c} strokeWidth="1.3" /><line x1="2" y1="9.8" x2="14" y2="9.8" stroke={c} strokeWidth="1" /><line x1="7" y1="3" x2="7" y2="13" stroke={c} strokeWidth="1" /></>,
  };
  return <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">{g[type] || g.bar}</svg>;
}

export function GripIcon() {
  return (
    <svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true" focusable="false">
      {[3, 8, 13].map((y) => [3, 7].map((x) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.3" fill="currentColor" />))}
    </svg>
  );
}

/**
 * Drag-to-move for a list of items with ids. The handle starts the drag; hovering another item moves the
 * dragged one into its place, so the layout shows the result while you drag.
 */
export function useDragSort<T extends { id: string }>(items: T[], setItems: (next: T[]) => void) {
  const [dragging, setDragging] = useState<string | null>(null);
  // The tile last swapped with: tiles of different sizes shift under the pointer after a swap, so only
  // entering a new tile moves things again (no flicker back and forth).
  const over = useRef<string | null>(null);
  const handle = (id: string, el: () => HTMLElement | null) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", id);
      const box = el();
      if (box) e.dataTransfer.setDragImage(box, 24, 24);
      over.current = null;
      setDragging(id);
    },
    onDragEnd: () => setDragging(null),
  });
  const target = (id: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dragging === id || over.current === id) return;
      over.current = id;
      const from = items.findIndex((x) => x.id === dragging);
      const to = items.findIndex((x) => x.id === id);
      if (from < 0 || to < 0) return;
      const next = [...items];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      setItems(next);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(null);
    },
  });
  const nudge = (id: string, d: number) => {
    const i = items.findIndex((x) => x.id === id);
    const j = i + d;
    if (i < 0 || j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    setItems(next);
  };
  return { dragging, handle, target, nudge };
}
