"use client";

/* The Word / PowerPoint-style toolbar shared by the deck and document editors.

   Formatting buttons act on the selected text when there is a selection (inline formatting, see ./rich);
   otherwise on the selected block or slide element as a whole (its `style`). Buttons keep the text
   selection alive (mousedown is cancelled), dropdowns restore it before applying. */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "../ui";
import { FONTS, SIZES, formatSelection, hasTextSelection, useFormatState, type InlineCommand } from "./rich";
import { uploadPicture, type Asset, type TextStyle } from "./shared";

export const SWATCHES = [
  "#000000", "#434343", "#666666", "#999999", "#cccccc", "#ffffff",
  "#c0392b", "#e67e22", "#f1c40f", "#27ae60", "#2980b9", "#8e44ad",
  "#ce401b", "#a87111", "#2e6650", "#1f4e79", "#7f1d1d", "#0f766e",
];
export const HIGHLIGHTS = ["#fff2a8", "#fde68a", "#bbf7d0", "#bfdbfe", "#fbcfe8", "#fed7aa", "#e5e7eb"];

export function RButton({
  children,
  onClick,
  active,
  disabled,
  title,
  wide,
}: {
  children: ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} // keep the text selection
      onClick={onClick}
      className={cx(
        "flex h-7 items-center justify-center gap-1 rounded-[2px] text-[12px] text-ink transition-colors disabled:opacity-35",
        wide ? "px-2" : "w-7",
        active ? "bg-ink/10 ring-1 ring-ink/30" : "hover:bg-ink/[0.06]",
      )}
    >
      {children}
    </button>
  );
}

export const Sep = () => <span className="mx-1 h-6 w-px shrink-0 bg-rule" aria-hidden />;

export function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-col items-stretch">
      <div className="flex items-center gap-0.5">{children}</div>
      <span className="mt-0.5 text-center text-[9.5px] uppercase tracking-[0.08em] text-mute">{label}</span>
    </div>
  );
}

/** A popover anchored under a button. */
export function Pop({
  button,
  title,
  children,
  wide,
}: {
  button: ReactNode;
  title: string;
  children: (close: () => void) => ReactNode;
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <RButton title={title} onClick={() => setOpen((o) => !o)} active={open} wide={wide}>
        {button}
      </RButton>
      {open && (
        <div
          className="absolute left-0 top-8 z-[80] min-w-[180px] border border-ink bg-white p-2 shadow-[0_8px_24px_rgba(0,0,0,0.18)]"
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).tagName !== "INPUT") e.preventDefault();
          }}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function ColorGrid({ colors, onPick, none }: { colors: string[]; onPick: (c: string) => void; none?: string }) {
  return (
    <div>
      <div className="grid grid-cols-6 gap-1">
        {colors.map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            aria-label={c}
            onClick={() => onPick(c)}
            className="h-5 w-5 border border-rule hover:scale-110"
            style={{ background: c }}
          />
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
        {none && (
          <button type="button" onClick={() => onPick("")} className="text-graphite hover:text-signal">
            {none}
          </button>
        )}
        <label className="flex items-center gap-1 text-graphite">
          Custom
          <input type="color" className="h-5 w-7 cursor-pointer border-0 p-0" onChange={(e) => onPick(e.target.value)} />
        </label>
      </div>
    </div>
  );
}

const ALIGN_ICONS: Record<NonNullable<TextStyle["align"]>, string[]> = {
  left: ["M3 6h18", "M3 10h12", "M3 14h18", "M3 18h12"],
  center: ["M3 6h18", "M6 10h12", "M3 14h18", "M6 18h12"],
  right: ["M3 6h18", "M9 10h12", "M3 14h18", "M9 18h12"],
  justify: ["M3 6h18", "M3 10h18", "M3 14h18", "M3 18h18"],
};

export function Icon({ d, size = 15 }: { d: string[]; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
      {d.map((p) => (
        <path key={p} d={p} />
      ))}
    </svg>
  );
}

/** Font, size, emphasis, colours and alignment. `style` is the selected block / element's own style. */
export function FormatGroups({
  style,
  onStyle,
  noAlign,
}: {
  style?: TextStyle;
  onStyle?: (patch: Partial<TextStyle>) => void;
  noAlign?: boolean;
}) {
  const fs = useFormatState();
  const st = style ?? {};
  // Selected text gets inline formatting; otherwise the whole block / text box.
  const apply = (cmd: InlineCommand, patch: Partial<TextStyle>) => {
    if (!formatSelection(cmd) && onStyle) onStyle(patch);
  };
  const off = !onStyle && !hasTextSelection();
  return (
    <>
      <Group label="Font">
        <select
          aria-label="Font"
          disabled={off}
          value={st.font ?? ""}
          onChange={(e) => apply({ kind: "font", value: e.target.value }, { font: e.target.value || undefined })}
          className="h-7 w-[132px] border border-rule bg-white px-1 text-[12px] disabled:opacity-40"
        >
          <option value="">Theme font</option>
          {FONTS.map((f) => (
            <option key={f} value={f} style={{ fontFamily: f }}>
              {f}
            </option>
          ))}
        </select>
        <select
          aria-label="Font size"
          disabled={off}
          value={st.size ?? ""}
          onChange={(e) => {
            const v = Number(e.target.value);
            apply({ kind: "size", value: v || 12 }, { size: v || undefined });
          }}
          className="h-7 w-[58px] border border-rule bg-white px-1 text-[12px] disabled:opacity-40"
        >
          <option value="">Auto</option>
          {SIZES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <RButton title="Bold (Ctrl+B)" disabled={off} active={fs.b || !!st.bold} onClick={() => apply({ kind: "toggle", mark: "b" }, { bold: !st.bold })}>
          <b>B</b>
        </RButton>
        <RButton title="Italic (Ctrl+I)" disabled={off} active={fs.i || !!st.italic} onClick={() => apply({ kind: "toggle", mark: "i" }, { italic: !st.italic })}>
          <i className="font-serif">I</i>
        </RButton>
        <RButton
          title="Underline (Ctrl+U)"
          disabled={off}
          active={fs.u || !!st.underline}
          onClick={() => apply({ kind: "toggle", mark: "u" }, { underline: !st.underline })}
        >
          <u>U</u>
        </RButton>
        <RButton title="Strikethrough (select text first)" active={fs.s} onClick={() => apply({ kind: "toggle", mark: "s" }, {})}>
          <s>S</s>
        </RButton>
        <Pop
          title="Font colour"
          button={
            <span className="flex flex-col items-center leading-none">
              <span className="text-[13px] font-semibold">A</span>
              <span className="mt-[1px] h-[3px] w-4" style={{ background: st.color || "#c0392b" }} />
            </span>
          }
        >
          {(close) => (
            <ColorGrid
              colors={SWATCHES}
              none="Automatic"
              onPick={(c) => {
                apply({ kind: "color", value: c || "#000000" }, { color: c || undefined });
                close();
              }}
            />
          )}
        </Pop>
        <Pop
          title="Highlight"
          button={
            <span className="flex flex-col items-center leading-none">
              <Icon size={13} d={["M4 20h6", "M14 4l6 6-8 8H6v-6z"]} />
              <span className="mt-[1px] h-[3px] w-4" style={{ background: st.bg || "#fff2a8" }} />
            </span>
          }
        >
          {(close) => (
            <ColorGrid
              colors={HIGHLIGHTS}
              none="No highlight"
              onPick={(c) => {
                apply({ kind: "bg", value: c }, { bg: c || undefined });
                close();
              }}
            />
          )}
        </Pop>
        <RButton
          title="Clear formatting"
          disabled={off}
          onClick={() => {
            if (!formatSelection({ kind: "clear" }) && onStyle)
              onStyle({ font: undefined, size: undefined, color: undefined, bg: undefined, bold: undefined, italic: undefined, underline: undefined });
          }}
        >
          <Icon d={["M6 4h12", "M12 4l-4 16", "M4 20l16-16"]} />
        </RButton>
      </Group>
      {!noAlign && (
        <>
          <Sep />
          <Group label="Paragraph">
            {(Object.keys(ALIGN_ICONS) as NonNullable<TextStyle["align"]>[]).map((a) => (
              <RButton
                key={a}
                title={`Align ${a}`}
                disabled={!onStyle}
                active={(st.align ?? "left") === a && !!onStyle}
                onClick={() => onStyle?.({ align: a })}
              >
                <Icon d={ALIGN_ICONS[a]} />
              </RButton>
            ))}
          </Group>
        </>
      )}
    </>
  );
}

/** Word's "Insert table" grid: hover to choose rows × columns (the first row is the header). */
export function TablePicker({ onPick }: { onPick: (rows: number, cols: number) => void }) {
  const [hover, setHover] = useState<[number, number] | null>(null);
  const R = 8,
    C = 8;
  return (
    <div>
      <div className="mb-1.5 text-[11px] text-graphite">{hover ? `${hover[0]} × ${hover[1]} table` : "Insert table"}</div>
      <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${C}, 1fr)` }} onMouseLeave={() => setHover(null)}>
        {Array.from({ length: R * C }, (_, k) => {
          const r = Math.floor(k / C) + 1,
            c = (k % C) + 1;
          const on = !!hover && r <= hover[0] && c <= hover[1];
          return (
            <button
              key={k}
              type="button"
              aria-label={`${r} by ${c} table`}
              onMouseEnter={() => setHover([r, c])}
              onClick={() => onPick(r, c)}
              className={cx("h-4 w-4 border", on ? "border-signal bg-signal/30" : "border-rule bg-white")}
            />
          );
        })}
      </div>
    </div>
  );
}

export function tableOf(rows: number, cols: number) {
  return {
    columns: Array.from({ length: cols }, (_, j) => `Column ${j + 1}`),
    rows: Array.from({ length: Math.max(1, rows - 1) }, () => Array.from({ length: cols }, () => "")),
  };
}

/** Insert a picture: upload one from the computer, or pick a chart the source produced. */
export function PicturePicker({
  assets,
  onPick,
  onError,
}: {
  assets: Asset[];
  onPick: (url: string, title?: string) => void;
  onError: (msg: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Pop
      title="Insert picture"
      wide
      button={
        <>
          <Icon d={["M4 5h16v14H4z", "M4 15l5-5 4 4 3-3 4 4", "M15 9h.01"]} />
          <span>{busy ? "Uploading…" : "Picture"}</span>
        </>
      }
    >
      {(close) => (
        <div className="w-[240px] space-y-2">
          <button
            type="button"
            onClick={() => input.current?.click()}
            className="w-full border border-ink px-2 py-1.5 text-left text-[12px] hover:bg-ink hover:text-paper"
          >
            Upload from this device…
            <span className="block text-[10.5px] opacity-60">PNG, JPEG, GIF, WebP · up to 8 MB</span>
          </button>
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              setBusy(true);
              try {
                onPick(await uploadPicture(f), f.name.replace(/\.[^.]+$/, ""));
                close();
              } catch (err) {
                onError(err instanceof Error ? err.message : String(err));
              } finally {
                setBusy(false);
              }
            }}
          />
          {assets.length > 0 && (
            <>
              <div className="text-[10.5px] uppercase tracking-[0.08em] text-mute">Charts from this report</div>
              <div className="grid max-h-56 grid-cols-2 gap-1 overflow-y-auto">
                {assets.map((a) => (
                  <button
                    key={a.url}
                    type="button"
                    title={a.title}
                    onClick={() => {
                      onPick(a.url, a.title);
                      close();
                    }}
                    className="border border-rule hover:border-ink"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={a.url} alt={a.title} className="h-16 w-full object-contain" />
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </Pop>
  );
}

/** Undo / redo for manual edits (text inside a box keeps the browser's own Ctrl+Z). */
export function HistoryGroup({ undo, redo, canUndo, canRedo }: { undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (mod && (k === "y" || (k === "z" && e.shiftKey))) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);
  return (
    <Group label="Undo">
      <RButton title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
        <Icon d={["M9 14L4 9l5-5", "M4 9h11a5 5 0 0 1 0 10h-3"]} />
      </RButton>
      <RButton title="Redo (Ctrl+Y)" disabled={!canRedo} onClick={redo}>
        <Icon d={["M15 14l5-5-5-5", "M20 9H9a5 5 0 0 0 0 10h3"]} />
      </RButton>
    </Group>
  );
}

/** The ribbon frame: tabs on top (Home / Insert / Design), the active tab's groups below. */
export function Ribbon({ tabs }: { tabs: { key: string; label: string; content: ReactNode }[] }) {
  const [tab, setTab] = useState(tabs[0]?.key);
  const cur = tabs.find((t) => t.key === tab) ?? tabs[0];
  return (
    <div className="shrink-0 border-b border-rule bg-white">
      <div className="flex gap-1 px-3 pt-1" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === cur?.key}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setTab(t.key)}
            className={cx(
              "border-b-2 px-3 py-1 text-[12px]",
              t.key === cur?.key ? "border-signal font-medium text-ink" : "border-transparent text-graphite hover:text-ink",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex min-h-[52px] items-start gap-1 overflow-x-auto px-3 py-1.5">{cur?.content}</div>
    </div>
  );
}
