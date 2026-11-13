"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from "react";
import { Button, cx } from "../ui";
import {
  AiBox,
  ChartEditor,
  EditableList,
  EditableText,
  Explanation,
  HistoryMenu,
  ImagePicker,
  MiniChart,
  SaveBadge,
  StaleBanner,
  TableBlock,
  emptyChart,
  emptyTable,
  newId,
  styleCss,
  useStudio,
  type Asset,
  type Deck,
  type Layout,
  type ShapeKind,
  type Slide,
  type SlideElement,
  type TextStyle,
} from "./shared";
import { ColorGrid, FormatGroups, Group, HistoryGroup, Icon, PicturePicker, Pop, RButton, Ribbon, Sep, SWATCHES, TablePicker, tableOf } from "./Ribbon";
import { ShareButton } from "./ShareDialog";
import { BrandMenu, brandVars, useBrandKits, type BrandKit } from "./brand";

/* A report's deck, editable like PowerPoint: a ribbon with fonts, sizes, colours and alignment; insert text
   boxes, pictures (upload or the report's charts), tables, charts and shapes anywhere on a slide, then drag
   and resize them; slide backgrounds and layouts; undo / redo; AI edits; present full screen; native .pptx. */

const LAYOUTS: { key: Layout; label: string }[] = [
  { key: "title", label: "Title" },
  { key: "section", label: "Section" },
  { key: "bullets", label: "Bullets" },
  { key: "two_column", label: "Two columns" },
  { key: "chart", label: "Chart" },
  { key: "table", label: "Table" },
  { key: "big_number", label: "Big number" },
  { key: "quote", label: "Quote" },
  { key: "image", label: "Chart image" },
  { key: "blank", label: "Blank" },
];
const SHAPES: { key: ShapeKind; label: string; d: string[] }[] = [
  { key: "rect", label: "Rectangle", d: ["M4 6h16v12H4z"] },
  { key: "rounded", label: "Rounded rectangle", d: ["M8 6h8a4 4 0 0 1 4 4v4a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-4a4 4 0 0 1 4-4z"] },
  { key: "ellipse", label: "Oval", d: ["M12 6c4.4 0 8 2.7 8 6s-3.6 6-8 6-8-2.7-8-6 3.6-6 8-6z"] },
  { key: "line", label: "Line", d: ["M4 18L20 6"] },
];

/** A slide is 13.333 in (960 pt) wide, so 1 pt = 100cqw / 960: text keeps its proportions as the slide scales. */
const CQ = { containerType: "inline-size", "--pt": "0.10417cqw" } as CSSProperties;

function blankSlide(layout: Layout, assets: Asset[]): Slide {
  const first = layout === "image" ? assets[0] : undefined;
  return {
    id: newId(),
    layout,
    title: layout === "title" ? "Presentation title" : layout === "section" ? "Section" : layout === "blank" ? "" : (first?.title ?? "New slide"),
    subtitle: "",
    bullets: layout === "bullets" ? ["First point"] : [],
    left: layout === "two_column" ? ["Point"] : [],
    right: layout === "two_column" ? ["Point"] : [],
    left_title: layout === "two_column" ? "Left" : "",
    right_title: layout === "two_column" ? "Right" : "",
    quote: layout === "quote" ? "Quote" : "",
    attribution: "",
    number: layout === "big_number" ? "0" : "",
    caption: first?.note ?? "",
    chart: layout === "chart" ? emptyChart() : null,
    table: layout === "table" ? emptyTable() : null,
    image: first?.url ?? "",
    notes: "",
    background: "",
    elements: [],
  };
}

function withLayout(s: Slide, layout: Layout, assets: Asset[]): Slide {
  const next = { ...s, layout };
  if (layout === "image" && !next.image && assets[0]) next.image = assets[0].url;
  if (layout === "chart" && !next.chart) next.chart = emptyChart();
  if (layout === "table" && !next.table) next.table = emptyTable();
  if (layout === "two_column" && !next.left.length && !next.right.length) {
    const half = Math.ceil(s.bullets.length / 2);
    next.left = s.bullets.slice(0, half);
    next.right = s.bullets.slice(half);
  }
  if (layout === "bullets" && !next.bullets.length) next.bullets = [...s.left, ...s.right];
  return next;
}

// ── Sections (like PowerPoint: a "Section" slide and the slides after it, up to the next one) ──

function deckSectionEnd(slides: Slide[], s: number): number {
  let e = s + 1;
  while (e < slides.length && slides[e].layout !== "section") e++;
  return e;
}

/** Move slides [s, e) so they sit before index t (t = slides.length → the end). */
function moveRange(slides: Slide[], s: number, e: number, t: number): Slide[] {
  if (t >= s && t <= e) return slides;
  const part = slides.slice(s, e);
  const rest = [...slides.slice(0, s), ...slides.slice(e)];
  const at = t > s ? t - (e - s) : t;
  return [...rest.slice(0, at), ...part, ...rest.slice(at)];
}

function moveDeckSection(slides: Slide[], s: number, dir: -1 | 1): Slide[] {
  const e = deckSectionEnd(slides, s);
  if (dir < 0) {
    let p = s - 1;
    while (p >= 0 && slides[p].layout !== "section") p--;
    const floor = slides[0]?.layout === "title" ? 1 : 0; // keep the title slide first
    const t = p >= 0 ? p : floor;
    return t < s ? moveRange(slides, s, e, t) : slides;
  }
  if (e >= slides.length) return slides;
  return moveRange(slides, s, e, deckSectionEnd(slides, e));
}

const plainTitle = (t?: string) => (t ?? "").replace(/\{\{[^|]*\|/g, "").replace(/\}\}|\*\*|\*|\+\+|~~/g, "").trim();

function newElement(type: SlideElement["type"], extra: Partial<SlideElement> = {}): SlideElement {
  const base: SlideElement = { id: newId(), type, x: 30, y: 30, w: 40, h: 20, style: {} };
  if (type === "text") return { ...base, text: "", style: { size: 20 }, ...extra };
  if (type === "image") return { ...base, x: 25, y: 22, w: 50, h: 56, ...extra };
  if (type === "table") return { ...base, x: 10, y: 28, w: 80, h: 40, table: emptyTable(), ...extra };
  if (type === "chart") return { ...base, x: 15, y: 25, w: 70, h: 60, chart: emptyChart(), ...extra };
  return {
    ...base,
    x: 35,
    y: 35,
    w: 30,
    h: 25,
    shape: "rect",
    fill: "#ce401b",
    stroke: "",
    text: "",
    style: { color: "#ffffff", align: "center" },
    ...extra,
  };
}

// ── Free-floating elements (text boxes, pictures, tables, charts, shapes) ────

function ElementBody({ el, editable, onChange }: { el: SlideElement; editable: boolean; onChange: (e: SlideElement) => void }) {
  const css = styleCss(el.style);
  if (el.type === "text")
    return (
      <EditableText
        value={el.text ?? ""}
        editable={editable}
        placeholder="Type text"
        className="h-full w-full overflow-hidden leading-[1.25] text-ink"
        style={{ fontSize: "calc(var(--pt) * 18)", ...css }}
        onChange={(v) => onChange({ ...el, text: v })}
      />
    );
  if (el.type === "image")
    // eslint-disable-next-line @next/next/no-img-element
    return el.image ? <img src={el.image} alt="" draggable={false} className="h-full w-full select-none object-contain" /> : null;
  if (el.type === "table" && el.table)
    return (
      <div className="h-full overflow-hidden" style={{ fontSize: "calc(var(--pt) * 12)", ...css }}>
        <TableBlock table={el.table} editable={editable} dense onChange={(t) => onChange({ ...el, table: t })} className="bg-white/80 text-ink" />
      </div>
    );
  if (el.type === "chart" && el.chart) return <MiniChart chart={el.chart} />;
  if (el.type === "shape") {
    if (el.shape === "line") return <div className="absolute inset-x-0 top-1/2" style={{ borderTop: `max(1px, 0.25cqw) solid ${el.stroke || "#181613"}` }} />;
    return (
      <div
        className="flex h-full w-full items-center justify-center overflow-hidden p-[0.6cqw]"
        style={{
          background: el.fill || "transparent",
          border: el.stroke ? `max(1px, 0.2cqw) solid ${el.stroke}` : undefined,
          borderRadius: el.shape === "ellipse" ? "50%" : el.shape === "rounded" ? "1.4cqw" : 0,
        }}
      >
        <EditableText
          value={el.text ?? ""}
          editable={editable}
          placeholder=""
          className="w-full"
          style={{ fontSize: "calc(var(--pt) * 16)", textAlign: "center", ...css }}
          onChange={(v) => onChange({ ...el, text: v })}
        />
      </div>
    );
  }
  return null;
}

function Elements({
  slide,
  editable,
  selected,
  onSelect,
  onChange,
}: {
  slide: Slide;
  editable: boolean;
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  onChange: (s: Slide) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const els = slide.elements ?? [];
  const latest = useRef(slide);
  latest.current = slide;
  const setEl = (e: SlideElement) => {
    const s = latest.current;
    onChange({ ...s, elements: (s.elements ?? []).map((x) => (x.id === e.id ? e : x)) });
  };

  /** Drag to move ("move") or resize from the corner ("size"); positions are % of the slide. */
  const startDrag = (e: RPointerEvent, el: SlideElement, mode: "move" | "size") => {
    e.preventDefault();
    e.stopPropagation();
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
    const x0 = e.clientX,
      y0 = e.clientY;
    const start = { ...el };
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const r = (n: number) => Math.round(n * 4) / 4;
    const move = (ev: PointerEvent) => {
      const dx = ((ev.clientX - x0) / rect.width) * 100;
      const dy = ((ev.clientY - y0) / rect.height) * 100;
      if (mode === "move")
        setEl({ ...start, x: r(Math.min(98, Math.max(-start.w + 2, start.x + dx))), y: r(Math.min(98, Math.max(-start.h + 2, start.y + dy))) });
      else setEl({ ...start, w: r(Math.min(100, Math.max(2, start.w + dx))), h: r(Math.min(100, Math.max(1, start.h + dy))) });
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  return (
    <div ref={box} className="pointer-events-none absolute inset-0">
      {els.map((el) => {
        const on = editable && selected === el.id;
        return (
          <div
            key={el.id}
            className={cx("absolute", editable && "pointer-events-auto", editable && !on && "hover:outline hover:outline-1 hover:outline-signal/40")}
            style={{
              left: `${el.x}%`,
              top: `${el.y}%`,
              width: `${el.w}%`,
              height: `${el.h}%`,
              outline: on ? "2px solid rgb(var(--signal))" : undefined,
            }}
            onMouseDown={(e) => {
              if (!editable) return;
              e.stopPropagation();
              onSelect?.(el.id);
            }}
          >
            <ElementBody el={el} editable={on} onChange={setEl} />
            {editable && !on && el.type !== "text" && (
              // Unselected pictures / charts / tables / shapes drag as a whole.
              <div
                className="absolute inset-0 cursor-move"
                onPointerDown={(e) => {
                  onSelect?.(el.id);
                  startDrag(e, el, "move");
                }}
              />
            )}
            {on && (
              <>
                <div
                  title="Drag to move"
                  onPointerDown={(e) => startDrag(e, el, "move")}
                  className="absolute -top-[22px] left-0 flex h-[20px] cursor-move select-none items-center gap-1 bg-signal px-1.5 text-[10px] text-white"
                >
                  ⠿ move
                </div>
                <div
                  title="Drag to resize"
                  onPointerDown={(e) => startDrag(e, el, "size")}
                  className="absolute -bottom-[6px] -right-[6px] h-3 w-3 cursor-nwse-resize border-2 border-white bg-signal"
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── One slide, at any size (all sizes are container-width units) ────────────

export function SlideCanvas({
  slide,
  n,
  editable = false,
  onChange = () => {},
  brand,
  selectedEl,
  onSelectEl,
}: {
  slide: Slide;
  n: number;
  editable?: boolean;
  onChange?: (s: Slide) => void;
  brand?: BrandKit;
  selectedEl?: string | null;
  onSelectEl?: (id: string | null) => void;
}) {
  const set = (patch: Partial<Slide>) => onChange({ ...slide, ...patch });
  const dark = slide.layout === "title";
  const explain = (
    <Explanation conclusion={slide.conclusion} action={slide.action} editable={editable} slide onChange={(p) => set(p)} />
  );
  const dash = <span className="text-signal">—</span>;
  const heading = (
    <div className="border-b border-ink pb-[1.2cqw]">
      <EditableText value={slide.title} editable={editable} single className="font-serif text-[3.3cqw] leading-[1.15] text-ink" onChange={(v) => set({ title: v })} />
    </div>
  );
  let body: JSX.Element | null;
  switch (slide.layout) {
    case "blank":
      body = null;
      break;
    case "title":
      body = (
        <div className="flex h-full items-center">
          <div className="flex w-full gap-[3cqw]">
            <div className="w-[0.9cqw] shrink-0 bg-signal" />
            <div className="min-w-0 flex-1 space-y-[1.4cqw]">
              <EditableText value={slide.title} editable={editable} single className="font-serif text-[4.6cqw] leading-[1.1] text-paper" onChange={(v) => set({ title: v })} />
              <EditableText value={slide.subtitle} editable={editable} placeholder="Subtitle" className="text-[1.8cqw] text-rule" onChange={(v) => set({ subtitle: v })} />
            </div>
          </div>
        </div>
      );
      break;
    case "section":
      body = (
        <div className="flex h-full flex-col justify-center gap-[1.4cqw]">
          <EditableText value={slide.title} editable={editable} single className="font-serif text-[4.4cqw] leading-[1.1] text-ink" onChange={(v) => set({ title: v })} />
          <EditableText value={slide.subtitle} editable={editable} placeholder="Subtitle" className="text-[1.8cqw] text-graphite" onChange={(v) => set({ subtitle: v })} />
        </div>
      );
      break;
    case "quote":
      body = (
        <div className="flex h-full flex-col justify-center gap-[2cqw] px-[5cqw]">
          <div className="flex font-serif text-[3.2cqw] leading-[1.3] text-ink">
            <span className="text-signal">“</span>
            <EditableText value={slide.quote} editable={editable} className="min-w-0 flex-1" onChange={(v) => set({ quote: v })} />
            <span className="text-signal">”</span>
          </div>
          <EditableText
            value={slide.attribution}
            editable={editable}
            single
            placeholder="Who said it"
            className="text-[1.6cqw] text-graphite"
            onChange={(v) => set({ attribution: v })}
          />
        </div>
      );
      break;
    case "big_number":
      body = (
        <div className="flex h-full flex-col">
          {heading}
          <div className="flex flex-1 flex-col justify-center gap-[1cqw]">
            <EditableText value={slide.number} editable={editable} single className="font-serif text-[11cqw] leading-none text-signal" onChange={(v) => set({ number: v })} />
            <EditableText
              value={slide.caption}
              editable={editable}
              placeholder="What the number means"
              className="max-w-[80%] text-[1.8cqw] text-graphite"
              onChange={(v) => set({ caption: v })}
            />
          </div>
        </div>
      );
      break;
    case "two_column":
      body = (
        <div className="flex h-full flex-col">
          {heading}
          <div className="mt-[2.4cqw] grid flex-1 grid-cols-2 gap-[4cqw]">
            {(["left", "right"] as const).map((side) => (
              <div key={side} className="min-w-0">
                <EditableText
                  value={slide[`${side}_title`]}
                  editable={editable}
                  single
                  placeholder="Column title"
                  className="mb-[1cqw] text-[1.45cqw] font-semibold text-signal"
                  onChange={(v) => set({ [`${side}_title`]: v } as Partial<Slide>)}
                />
                <EditableList
                  items={slide[side]}
                  editable={editable}
                  onChange={(v) => set({ [side]: v } as Partial<Slide>)}
                  className="space-y-[0.9cqw] text-[1.75cqw] text-ink"
                  marker={() => dash}
                />
              </div>
            ))}
          </div>
        </div>
      );
      break;
    case "chart":
      body = (
        <div className="flex h-full flex-col">
          {heading}
          <div className="mt-[1.5cqw] min-h-0 flex-1">{slide.chart && <MiniChart chart={slide.chart} />}</div>
          <EditableText value={slide.caption} editable={editable} placeholder="Caption" className="mt-[0.6cqw] text-[1.35cqw] text-graphite" onChange={(v) => set({ caption: v })} />
          {explain}
        </div>
      );
      break;
    case "image":
      body = (
        <div className="flex h-full flex-col">
          {heading}
          <div className="mt-[1.5cqw] flex min-h-0 flex-1 items-center justify-center">
            {slide.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={slide.image} alt={slide.title} className="max-h-full max-w-full object-contain" />
            ) : (
              <span className="text-[1.4cqw] text-mute">Pick a chart in the side panel</span>
            )}
          </div>
          <EditableText value={slide.caption} editable={editable} placeholder="Caption" className="mt-[0.6cqw] text-[1.35cqw] text-graphite" onChange={(v) => set({ caption: v })} />
          {explain}
        </div>
      );
      break;
    case "table":
      body = (
        <div className="flex h-full flex-col">
          {heading}
          {slide.table && (
            <TableBlock
              table={slide.table}
              editable={editable}
              dense
              onChange={(t) => set({ table: t })}
              className="mt-[1.8cqw] min-h-0 flex-1 overflow-hidden text-[1.25cqw] text-ink"
            />
          )}
          {explain}
        </div>
      );
      break;
    default:
      body = (
        <div className="flex h-full flex-col">
          {heading}
          <EditableList items={slide.bullets} editable={editable} onChange={(v) => set({ bullets: v })} className="mt-[2.4cqw] space-y-[1.1cqw] text-[2cqw] text-ink" marker={() => dash} />
        </div>
      );
  }
  return (
    <div
      style={{ ...CQ, ...brandVars(brand, dark), ...(slide.background ? { background: slide.background } : {}) }}
      className={cx("relative aspect-[16/9] w-full overflow-hidden text-left", dark ? "bg-ink" : "bg-paper")}
      onMouseDown={() => editable && onSelectEl?.(null)}
    >
      {body && <div className="absolute inset-0 px-[5.2cqw] pb-[4cqw] pt-[3.6cqw]">{body}</div>}
      <Elements slide={slide} editable={editable} selected={selectedEl} onSelect={onSelectEl} onChange={onChange} />
      {brand?.logo && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={brand.logo} alt="" className={cx("absolute w-auto", dark ? "left-[8.2cqw] top-[4.5cqw] h-[5.2cqw]" : "bottom-[1.2cqw] left-[5.2cqw] h-[2.4cqw]")} />
      )}
      {!dark && brand?.footer && (
        <span className={cx("absolute bottom-[1.6cqw] font-sans text-[0.9cqw] text-mute", brand.logo ? "left-[14cqw]" : "left-[5.2cqw]")}>{brand.footer}</span>
      )}
      <span className={cx("absolute bottom-[1.6cqw] right-[2.4cqw] font-mono text-[0.9cqw]", dark ? "text-rule" : "text-mute")}>{n}</span>
    </div>
  );
}

// ── Present mode ────────────────────────────────────────────────────────────

export function Present({ slides, start, onClose, brand }: { slides: Slide[]; start: number; onClose: () => void; brand?: BrandKit }) {
  const [i, setI] = useState(start);
  const [notes, setNotes] = useState(false);
  const go = useCallback((d: number) => setI((x) => Math.min(slides.length - 1, Math.max(0, x + d))), [slides.length]);

  useEffect(() => {
    document.documentElement.requestFullscreen?.().catch(() => {});
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(e.key)) go(1);
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(e.key)) go(-1);
      else if (e.key === "Home") setI(0);
      else if (e.key === "End") setI(slides.length - 1);
      else if (e.key.toLowerCase() === "n") setNotes((x) => !x);
      else if (e.key === "Escape") onClose();
    };
    const onFs = () => {
      if (!document.fullscreenElement) onClose();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onFs);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFs);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    };
  }, [go, onClose, slides.length]);

  const s = slides[i];
  return (
    <div className="fixed inset-0 z-[70] flex flex-col items-center justify-center bg-night" onClick={() => go(1)}>
      <div className="w-[min(100vw,177.78vh)]">{s && <SlideCanvas slide={s} n={i + 1} brand={brand} />}</div>
      {notes && s?.notes && (
        <div
          className="absolute inset-x-0 bottom-0 max-h-[30vh] overflow-y-auto whitespace-pre-wrap bg-black/85 px-8 py-4 text-[15px] leading-relaxed text-paper"
          onClick={(e) => e.stopPropagation()}
        >
          {s.notes}
        </div>
      )}
      <div className="absolute bottom-3 right-4 flex items-center gap-4 font-mono text-[11px] text-white/40" onClick={(e) => e.stopPropagation()}>
        <span>N notes · ← → move · Esc exit</span>
        <span>
          {i + 1} / {slides.length}
        </span>
      </div>
    </div>
  );
}

// ── Editor ──────────────────────────────────────────────────────────────────

const SUGGESTIONS = ["Make it shorter", "Turn this into a chart", "Split into two slides", "Write speaker notes", "Translate to Bahasa Indonesia"];

export function DeckEditor({ prefix, onClose, backLabel = "← Back" }: { prefix: string; onClose: () => void; backLabel?: string }) {
  const st = useStudio<Deck>(prefix, "deck");
  const [sel, setSel] = useState(0);
  const [elId, setElId] = useState<string | null>(null);
  const [presenting, setPresenting] = useState(false);
  const deck = st.data;
  const bk = useBrandKits();
  const kit = bk.pick(deck?.brand_id);
  const slides = deck?.slides ?? [];
  const cur = Math.min(sel, Math.max(0, slides.length - 1));
  const slide = slides[cur];
  const assets = deck?.assets ?? [];
  const els = slide?.elements ?? [];
  const el = els.find((e) => e.id === elId) ?? null;
  const layouts = LAYOUTS.filter((l) => l.key !== "image" || assets.length > 0 || slide?.layout === "image");

  const setSlides = (next: Slide[]) => deck && st.update({ ...deck, slides: next });
  const setSlide = (s: Slide) => setSlides(slides.map((x) => (x.id === s.id ? s : x)));
  const setEls = (next: SlideElement[]) => slide && setSlide({ ...slide, elements: next });
  const setEl = (e: SlideElement) => setEls(els.map((x) => (x.id === e.id ? e : x)));
  const addEl = (e: SlideElement) => {
    if (!slide) return;
    setEls([...els, e]);
    setElId(e.id);
  };
  const removeEl = () => {
    if (!el) return;
    setEls(els.filter((x) => x.id !== el.id));
    setElId(null);
  };
  const reorderEl = (d: number) => {
    if (!el) return;
    const i = els.findIndex((x) => x.id === el.id);
    const j = Math.min(els.length - 1, Math.max(0, i + d));
    if (i === j) return;
    const next = [...els];
    next.splice(i, 1);
    next.splice(j, 0, el);
    setEls(next);
  };
  const addSlide = (layout: Layout) => {
    const next = [...slides];
    next.splice(cur + 1, 0, blankSlide(layout, assets));
    setSlides(next);
    setSel(cur + 1);
    setElId(null);
  };
  const moveSlide = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= slides.length) return;
    const next = [...slides];
    [next[i], next[j]] = [next[j], next[i]];
    setSlides(next);
    setSel(j);
  };
  const move = (d: number) => moveSlide(cur, d);
  const duplicateSlide = (i: number) => {
    const next = [...slides];
    next.splice(i + 1, 0, { ...structuredClone(slides[i]), id: newId() });
    setSlides(next);
    setSel(i + 1);
  };
  const deleteSlide = (i: number) => {
    if (slides.length <= 1) return;
    setSlides(slides.filter((_, k) => k !== i));
    setSel(Math.max(0, Math.min(i, slides.length - 2)));
    setElId(null);
  };
  // Sections: a "Section" slide and the slides after it, up to the next one.
  let secStart = cur;
  while (secStart >= 0 && slides[secStart]?.layout !== "section") secStart--;
  const secEnd = secStart >= 0 ? deckSectionEnd(slides, secStart) : -1;
  const shiftSection = (s: number, dir: -1 | 1) => {
    const id = slides[cur]?.id;
    const next = moveDeckSection(slides, s, dir);
    setSlides(next);
    setSel(Math.max(0, next.findIndex((x) => x.id === id)));
  };
  const removeSection = (s: number) => {
    const e = deckSectionEnd(slides, s);
    if (e - s >= slides.length) return;
    const name = plainTitle(slides[s].title) || "this section";
    if (!window.confirm(`Delete the section “${name}” and its ${e - s} slide${e - s === 1 ? "" : "s"}? You can undo with Ctrl+Z.`)) return;
    setSlides([...slides.slice(0, s), ...slides.slice(e)]);
    setSel(Math.max(0, s - 1));
    setElId(null);
  };
  const duplicateSection = (s: number) => {
    const e = deckSectionEnd(slides, s);
    const copy = slides.slice(s, e).map((x) => ({ ...structuredClone(x), id: newId() }));
    setSlides([...slides.slice(0, e), ...copy, ...slides.slice(e)]);
    setSel(e);
  };
  const [drag, setDrag] = useState<{ from: number; to: number; section: boolean } | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const drop = (t: number) => {
    if (drag) {
      const id = slides[cur]?.id;
      const next = moveRange(slides, drag.from, drag.to, t);
      setSlides(next);
      setSel(Math.max(0, next.findIndex((x) => x.id === id)));
    }
    setDrag(null);
    setDropAt(null);
  };
  const onStyle =
    el && el.type !== "image" && el.type !== "chart"
      ? (patch: Partial<TextStyle>) => {
          const merged: TextStyle = { ...el.style, ...patch };
          (Object.keys(merged) as (keyof TextStyle)[]).forEach((k) => merged[k] === undefined && delete merged[k]);
          setEl({ ...el, style: merged });
        }
      : undefined;

  const close = useCallback(async () => {
    await st.flush();
    onClose();
  }, [st, onClose]);

  // Keyboard: Delete removes the selected box, arrows nudge it (Shift = 5%); without a box, arrows change slide.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (presenting || t.isContentEditable || ["TEXTAREA", "INPUT", "SELECT"].includes(t.tagName)) return;
    if (el && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      removeEl();
    } else if (el && e.key.startsWith("Arrow")) {
      e.preventDefault();
      const step = e.shiftKey ? 5 : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      setEl({ ...el, x: el.x + dx, y: el.y + dy });
    } else if (e.key === "ArrowDown") setSel((x) => Math.min(slides.length - 1, x + 1));
    else if (e.key === "ArrowUp") setSel((x) => Math.max(0, x - 1));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const newSlideMenu = (
    <Pop title="New slide" wide button={<>＋ New slide</>}>
      {(done) => (
        <div className="grid w-[220px] grid-cols-2 gap-1">
          {layouts.map((l) => (
            <button
              key={l.key}
              type="button"
              onClick={() => {
                addSlide(l.key);
                done();
              }}
              className="border border-rule px-1.5 py-1 text-[11px] hover:border-ink"
            >
              {l.label}
            </button>
          ))}
        </div>
      )}
    </Pop>
  );

  const ribbon = (
    <Ribbon
      tabs={[
        {
          key: "home",
          label: "Home",
          content: (
            <>
              <HistoryGroup undo={st.undo} redo={st.redo} canUndo={st.canUndo} canRedo={st.canRedo} />
              <Sep />
              <Group label="Slides">
                {newSlideMenu}
                <RButton title="Duplicate slide" disabled={!slide} onClick={() => duplicateSlide(cur)}>
                  <Icon d={["M8 8h11v11H8z", "M5 16V5h11"]} />
                </RButton>
                <RButton title="Move slide up" disabled={cur <= 0} onClick={() => move(-1)}>
                  <Icon d={["M12 19V5", "M6 11l6-6 6 6"]} />
                </RButton>
                <RButton title="Move slide down" disabled={cur >= slides.length - 1} onClick={() => move(1)}>
                  <Icon d={["M12 5v14", "M6 13l6 6 6-6"]} />
                </RButton>
                <RButton title="Delete slide" disabled={slides.length <= 1} onClick={() => deleteSlide(cur)}>
                  <Icon d={["M5 7h14", "M10 7V5h4v2", "M7 7l1 12h8l1-12"]} />
                </RButton>
              </Group>
              <Sep />
              <Group label="Section">
                <RButton title="Add a section here (a Section slide that groups the slides after it)" wide disabled={!slide} onClick={() => addSlide("section")}>
                  ＋ §
                </RButton>
                <RButton title="Move this section up (with all its slides)" wide disabled={secStart < 0} onClick={() => shiftSection(secStart, -1)}>
                  <Icon d={["M12 19V5", "M6 11l6-6 6 6"]} />§
                </RButton>
                <RButton title="Move this section down" wide disabled={secStart < 0 || secEnd >= slides.length} onClick={() => shiftSection(secStart, 1)}>
                  <Icon d={["M12 5v14", "M6 13l6 6 6-6"]} />§
                </RButton>
                <RButton title="Duplicate this section" disabled={secStart < 0} onClick={() => duplicateSection(secStart)}>
                  <Icon d={["M8 8h11v11H8z", "M5 16V5h11"]} />
                </RButton>
                <RButton title="Delete this section and its slides" disabled={secStart < 0} onClick={() => removeSection(secStart)}>
                  <Icon d={["M5 7h14", "M10 7V5h4v2", "M7 7l1 12h8l1-12"]} />
                </RButton>
              </Group>
              <Sep />
              <Group label="Visuals">
                <RButton
                  title="Write a Conclusion and an Actionable insight for every chart, table and picture slide that lacks one (3 credits)"
                  wide
                  disabled={!!st.busy}
                  onClick={() => void st.explain(false)}
                >
                  ✨ Explain
                </RButton>
                <RButton title="Rewrite the Conclusion and Actionable insight of every visual slide (3 credits)" wide disabled={!!st.busy} onClick={() => void st.explain(true)}>
                  Rewrite all
                </RButton>
              </Group>
              <Sep />
              <FormatGroups style={el?.style} onStyle={onStyle} />
            </>
          ),
        },
        {
          key: "insert",
          label: "Insert",
          content: (
            <>
              <Group label="Slides">{newSlideMenu}</Group>
              <Sep />
              <Group label="Text">
                <RButton title="Text box" wide disabled={!slide} onClick={() => addEl(newElement("text", { x: 10, y: 40, w: 50, h: 15 }))}>
                  <Icon d={["M4 5h16", "M12 5v14", "M8 19h8"]} />
                  Text box
                </RButton>
              </Group>
              <Sep />
              <Group label="Tables">
                <Pop
                  title="Insert table"
                  wide
                  button={
                    <>
                      <Icon d={["M3 5h18v14H3z", "M3 10h18", "M3 15h18", "M9 5v14", "M15 5v14"]} />
                      Table
                    </>
                  }
                >
                  {(done) => (
                    <TablePicker
                      onPick={(r, c) => {
                        addEl(newElement("table", { table: tableOf(r, c), h: Math.min(70, 8 + r * 7) }));
                        done();
                      }}
                    />
                  )}
                </Pop>
              </Group>
              <Sep />
              <Group label="Illustrations">
                <PicturePicker assets={assets} onError={st.setError} onPick={(url) => addEl(newElement("image", { image: url }))} />
                <RButton title="Chart (edit its data on the right)" wide disabled={!slide} onClick={() => addEl(newElement("chart"))}>
                  <Icon d={["M4 20V10", "M10 20V4", "M16 20v-7", "M3 20h18"]} />
                  Chart
                </RButton>
                <Pop
                  title="Shapes"
                  wide
                  button={
                    <>
                      <Icon d={["M4 4h8v8H4z", "M17 13a4 4 0 1 1 0 8 4 4 0 0 1 0-8z"]} />
                      Shapes
                    </>
                  }
                >
                  {(done) => (
                    <div className="flex gap-1">
                      {SHAPES.map((s) => (
                        <RButton
                          key={s.key}
                          title={s.label}
                          onClick={() => {
                            addEl(newElement("shape", s.key === "line" ? { shape: "line", fill: "", stroke: "#181613", h: 4, w: 40 } : { shape: s.key }));
                            done();
                          }}
                        >
                          <Icon d={s.d} />
                        </RButton>
                      ))}
                    </div>
                  )}
                </Pop>
              </Group>
            </>
          ),
        },
        {
          key: "design",
          label: "Design",
          content: (
            <>
              <Group label="Layout">
                <select
                  aria-label="Slide layout"
                  disabled={!slide}
                  value={slide?.layout ?? "bullets"}
                  onChange={(e) => slide && setSlide(withLayout(slide, e.target.value as Layout, assets))}
                  className="h-7 w-[130px] border border-rule bg-white px-1 text-[12px]"
                >
                  {layouts.map((l) => (
                    <option key={l.key} value={l.key}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </Group>
              <Sep />
              <Group label="Background">
                <Pop
                  title="Slide background"
                  wide
                  button={
                    <>
                      <span className="h-3.5 w-3.5 border border-rule" style={{ background: slide?.background || "#f3efe7" }} />
                      Background
                    </>
                  }
                >
                  {(done) => (
                    <ColorGrid
                      colors={[...SWATCHES, "#f3efe7", "#fbf9f4", "#181613", "#0b2545", "#e8f3ff", "#fdf2e9"]}
                      none="Theme default"
                      onPick={(c) => {
                        if (slide) setSlide({ ...slide, background: c });
                        done();
                      }}
                    />
                  )}
                </Pop>
                <RButton
                  title="Use this slide's background on every slide"
                  wide
                  disabled={!slide}
                  onClick={() => slide && setSlides(slides.map((s) => ({ ...s, background: slide.background ?? "" })))}
                >
                  Apply to all
                </RButton>
              </Group>
            </>
          ),
        },
      ]}
    />
  );

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-sheet">
      <div className="flex items-center gap-3 border-b border-ink bg-paper px-4 py-2">
        <button onClick={close} className="whitespace-nowrap text-[12.5px] text-graphite hover:text-ink">
          {backLabel}
        </button>
        <span className="h-4 w-px bg-rule" />
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-signal">Deck</span>
        <div className="min-w-0 flex-1">
          {deck && <EditableText value={deck.title} single className="truncate font-serif text-[17px] text-ink" onChange={(v) => st.update({ ...deck, title: v })} />}
        </div>
        <SaveBadge state={st.state} busy={st.busy} />
        <ShareButton createUrl={`${prefix}/deck/share`} listUrl={`${prefix}/deck/shares`} />
        <BrandMenu current={kit} kits={bk.kits} fonts={bk.fonts} reload={bk.reload} onPick={(id) => deck && st.update({ ...deck, brand_id: id })} />
        <HistoryMenu load={st.versions} onRestore={(v) => void st.restore(v)} onRebuild={() => void st.rebuild()} />
        <Button size="sm" tone="line" disabled={!deck} onClick={() => void st.download("pptx")}>
          Export .pptx
        </Button>
        <Button size="sm" tone="signal" disabled={!slides.length} onClick={() => setPresenting(true)}>
          ▶ Present
        </Button>
      </div>
      {deck && ribbon}
      <StaleBanner show={st.data?.stale && !st.busy} busy={!!st.busy} onUpdate={() => void st.rebuild()} />
      {st.error && (
        <div className="flex items-center gap-3 border-b border-signal/40 bg-signal/5 px-4 py-1.5 text-[12px] text-graphite">
          <span className="flex-1">{st.error}</span>
          {/Reload/.test(st.error) && (
            <button onClick={() => void st.reload()} className="text-signal underline">
              Reload
            </button>
          )}
          <button onClick={() => st.setError("")} className="text-mute hover:text-ink" aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {!deck ? (
        <div className="grid flex-1 place-items-center px-6 text-center text-[13px] text-mute">
          {st.state === "loading" ? "Preparing the deck from the report… the first time can take a minute or two." : "Couldn't open the deck."}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[190px_minmax(0,1fr)_300px]">
          <div className="overflow-y-auto border-r border-rule bg-paper p-3">
            <ol className="space-y-2.5">
              {slides.map((s, i) => (
                <li key={s.id}>
                  {s.layout === "section" && (
                    <div
                      draggable
                      onDragStart={(ev) => {
                        ev.dataTransfer.effectAllowed = "move";
                        setDrag({ from: i, to: deckSectionEnd(slides, i), section: true });
                      }}
                      onDragEnd={() => {
                        setDrag(null);
                        setDropAt(null);
                      }}
                      className="group/sec mb-1 flex cursor-grab items-center gap-1 border-b border-ink/30 pb-0.5 text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink"
                      title="Section: drag to move it with all its slides"
                    >
                      <span className="text-mute">⠿ §</span>
                      <span className="min-w-0 flex-1 truncate">{plainTitle(s.title) || "Section"}</span>
                      <span className="hidden gap-0.5 normal-case group-hover/sec:flex">
                        <button title="Move section up" onClick={() => shiftSection(i, -1)} className="px-0.5 text-mute hover:text-ink">
                          ↑
                        </button>
                        <button title="Move section down" onClick={() => shiftSection(i, 1)} className="px-0.5 text-mute hover:text-ink">
                          ↓
                        </button>
                        <button title="Delete section and its slides" onClick={() => removeSection(i)} className="px-0.5 text-mute hover:text-signal">
                          ×
                        </button>
                      </span>
                    </div>
                  )}
                  <div
                    draggable
                    onDragStart={(ev) => {
                      ev.dataTransfer.effectAllowed = "move";
                      setDrag({ from: i, to: i + 1, section: false });
                    }}
                    onDragEnd={() => {
                      setDrag(null);
                      setDropAt(null);
                    }}
                    onDragOver={(ev) => {
                      if (!drag) return;
                      ev.preventDefault();
                      setDropAt(i);
                    }}
                    onDrop={(ev) => {
                      ev.preventDefault();
                      drop(i);
                    }}
                    className={cx("group/thumb relative flex gap-1.5", dropAt === i && drag && "before:absolute before:-top-1.5 before:left-5 before:right-0 before:h-[3px] before:bg-signal")}
                  >
                    <span className="w-4 pt-0.5 text-right font-mono text-[10px] text-mute">{i + 1}</span>
                    <button
                      onClick={() => {
                        setSel(i);
                        setElId(null);
                      }}
                      className={cx("block min-w-0 flex-1 cursor-grab border-2 transition-colors", i === cur ? "border-signal" : "border-transparent hover:border-rule")}
                      aria-label={`Slide ${i + 1}: ${s.title}`}
                    >
                      <div className="pointer-events-none">
                        <SlideCanvas slide={s} n={i + 1} brand={kit} />
                      </div>
                    </button>
                    <div className="absolute right-0.5 top-0.5 hidden gap-px bg-white/95 text-[10.5px] leading-none shadow-sm group-hover/thumb:flex">
                      <button title="Move up" disabled={i === 0} onClick={() => moveSlide(i, -1)} className="px-1 py-0.5 text-graphite hover:text-ink disabled:opacity-30">
                        ↑
                      </button>
                      <button title="Move down" disabled={i === slides.length - 1} onClick={() => moveSlide(i, 1)} className="px-1 py-0.5 text-graphite hover:text-ink disabled:opacity-30">
                        ↓
                      </button>
                      <button title="Duplicate" onClick={() => duplicateSlide(i)} className="px-1 py-0.5 text-graphite hover:text-ink">
                        ⧉
                      </button>
                      <button title="Delete slide" disabled={slides.length <= 1} onClick={() => deleteSlide(i)} className="px-1 py-0.5 text-graphite hover:text-signal disabled:opacity-30">
                        ×
                      </button>
                    </div>
                  </div>
                </li>
              ))}
              {drag && (
                <li
                  onDragOver={(ev) => {
                    ev.preventDefault();
                    setDropAt(slides.length);
                  }}
                  onDrop={(ev) => {
                    ev.preventDefault();
                    drop(slides.length);
                  }}
                  className={cx("border border-dashed px-2 py-2 text-center text-[10.5px] text-mute", dropAt === slides.length ? "border-signal" : "border-rule")}
                >
                  Drop here to move to the end
                </li>
              )}
            </ol>
            <p className="mt-2 text-[10px] leading-relaxed text-mute">Drag slides (or a § section) to reorder. Hover a slide for ↑ ↓ ⧉ ×.</p>
            <Button size="sm" tone="line" className="mt-3 w-full" onClick={() => addSlide("bullets")}>
              + New slide
            </Button>
          </div>

          <div className="min-w-0 overflow-y-auto bg-[#e9e6df] px-8 py-6">
            {slide && (
              <div className="mx-auto max-w-[980px]">
                <div className="mb-2 flex items-center gap-1 text-[11.5px] text-graphite">
                  <span className="mr-auto font-mono text-[10.5px] text-mute">
                    Slide {cur + 1} of {slides.length} · select text to format it · click a box to move / resize it
                  </span>
                  <Button size="sm" tone="quiet" disabled={cur === 0} onClick={() => move(-1)} title="Move slide up">
                    ↑
                  </Button>
                  <Button size="sm" tone="quiet" disabled={cur === slides.length - 1} onClick={() => move(1)} title="Move slide down">
                    ↓
                  </Button>
                  <Button size="sm" tone="quiet" disabled={slides.length <= 1} onClick={() => deleteSlide(cur)}>
                    Delete slide
                  </Button>
                </div>
                <div className="mt-6 shadow-[0_18px_40px_-18px_rgb(var(--ink)/0.45)] ring-1 ring-ink/80">
                  <SlideCanvas key={slide.id} slide={slide} n={cur + 1} editable onChange={setSlide} brand={kit} selectedEl={elId} onSelectEl={setElId} />
                </div>
                <label className="mt-4 block">
                  <span className="label mb-1 block">Speaker notes</span>
                  <textarea
                    value={slide.notes}
                    onChange={(e) => setSlide({ ...slide, notes: e.target.value })}
                    rows={4}
                    placeholder="What to say on this slide (press N while presenting to see them; also exported to PowerPoint's notes)"
                    className="w-full resize-y border border-rule bg-white px-3 py-2 text-[13px] leading-relaxed focus:border-ink focus:outline-none"
                  />
                </label>
              </div>
            )}
          </div>

          <div className="space-y-6 overflow-y-auto border-l border-rule bg-paper p-4">
            {el ? (
              <div className="space-y-3">
                <div className="label">Selected {el.type === "text" ? "text box" : el.type}</div>
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" tone="quiet" onClick={() => reorderEl(1)}>
                    Bring forward
                  </Button>
                  <Button size="sm" tone="quiet" onClick={() => reorderEl(-1)}>
                    Send back
                  </Button>
                  <Button size="sm" tone="quiet" onClick={() => addEl({ ...structuredClone(el), id: newId(), x: el.x + 3, y: el.y + 3 })}>
                    Duplicate
                  </Button>
                  <Button size="sm" tone="quiet" onClick={removeEl}>
                    Delete
                  </Button>
                </div>
                <div className="grid grid-cols-4 gap-1 text-[10.5px] text-mute">
                  {(["x", "y", "w", "h"] as const).map((k) => (
                    <label key={k} className="block">
                      {{ x: "Left %", y: "Top %", w: "Width %", h: "Height %" }[k]}
                      <input
                        type="number"
                        value={el[k]}
                        step={1}
                        onChange={(e) => setEl({ ...el, [k]: Number(e.target.value) })}
                        className="mt-0.5 w-full border border-rule bg-white px-1 py-0.5 text-[11.5px] text-ink"
                      />
                    </label>
                  ))}
                </div>
                {el.type === "shape" && (
                  <div className="space-y-2">
                    {el.shape !== "line" && (
                      <>
                        <div className="label">Fill</div>
                        <ColorGrid colors={SWATCHES} none="No fill" onPick={(c) => setEl({ ...el, fill: c })} />
                      </>
                    )}
                    <div className="label">{el.shape === "line" ? "Line colour" : "Outline"}</div>
                    <ColorGrid colors={SWATCHES} none="No outline" onPick={(c) => setEl({ ...el, stroke: c })} />
                  </div>
                )}
                {el.type === "chart" && el.chart && (
                  <div>
                    <div className="label mb-2">Chart type and data</div>
                    <ChartEditor chart={el.chart} onChange={(c) => setEl({ ...el, chart: c })} />
                  </div>
                )}
                {el.type === "image" && (
                  <div className="flex items-center gap-2 text-[11.5px] text-graphite">
                    Replace:
                    <PicturePicker assets={assets} onError={st.setError} onPick={(url) => setEl({ ...el, image: url })} />
                  </div>
                )}
                {(el.type === "text" || el.type === "table") && (
                  <p className="text-[11.5px] leading-relaxed text-mute">
                    Use the Home tab to set the font, size, colour and alignment of the whole box, or select words to format only those.
                  </p>
                )}
                <p className="text-[11px] text-mute">Arrow keys nudge (Shift = 5%), Delete removes.</p>
              </div>
            ) : (
              slide && (
                <div>
                  <div className="label mb-2">Layout</div>
                  <div className="grid grid-cols-2 gap-1">
                    {layouts.map((l) => (
                      <button
                        key={l.key}
                        onClick={() => setSlide(withLayout(slide, l.key, assets))}
                        className={cx(
                          "border px-2 py-1 text-[11.5px]",
                          slide.layout === l.key ? "border-ink bg-ink text-paper" : "border-rule bg-white hover:border-ink",
                        )}
                      >
                        {l.label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-mute">
                    Add text boxes, pictures, tables, charts and shapes from the Insert tab; drag them anywhere on the slide.
                  </p>
                </div>
              )
            )}
            {!el && slide?.layout === "image" && (
              <div>
                <div className="label mb-2">Chart image</div>
                <ImagePicker assets={assets} value={slide.image} onPick={(a) => setSlide({ ...slide, image: a.url, caption: slide.caption || a.note })} />
              </div>
            )}
            {!el && slide?.layout === "chart" && slide.chart && (
              <div>
                <div className="label mb-2">Chart data</div>
                <ChartEditor chart={slide.chart} onChange={(c) => setSlide({ ...slide, chart: c })} />
              </div>
            )}
            <AiBox noun="slide" hasTarget={!!slide} suggestions={SUGGESTIONS} busy={!!st.busy} onRun={(text, whole) => st.ai(text, whole ? "" : slide?.id)} />
          </div>
        </div>
      )}

      {presenting && slides.length > 0 && <Present slides={slides} start={cur} onClose={() => setPresenting(false)} brand={kit} />}
    </div>
  );
}
