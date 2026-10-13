"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Button, cx } from "../ui";
import {
  AiBox,
  ChartEditor,
  EditableList,
  EditableText,
  HistoryMenu,
  ImagePicker,
  MiniChart,
  SaveBadge,
  StaleBanner,
  TableBlock,
  emptyChart,
  emptyTable,
  newId,
  useStudio,
  type Asset,
  type Deck,
  type Layout,
  type Slide,
} from "./shared";
import { ShareButton } from "./ShareDialog";
import { BrandMenu, brandVars, useBrandKits, type BrandKit } from "./brand";

/* A report's deck (Agent task or Analytics run), editable in place: click any text, reorder slides, switch layouts, edit chart data,
   ask Claude to change a slide or the whole deck, present full screen, export a native .pptx. */

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
];

const CQ: CSSProperties = { containerType: "inline-size" };

function blankSlide(layout: Layout, assets: Asset[]): Slide {
  const first = layout === "image" ? assets[0] : undefined;
  return {
    id: newId(),
    layout,
    title: layout === "title" ? "Presentation title" : layout === "section" ? "Section" : (first?.title ?? "New slide"),
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

// ── One slide, at any size (all sizes are container-width units) ────────────

export function SlideCanvas({
  slide,
  n,
  editable = false,
  onChange = () => {},
  brand,
}: {
  slide: Slide;
  n: number;
  editable?: boolean;
  onChange?: (s: Slide) => void;
  brand?: BrandKit;
}) {
  const set = (patch: Partial<Slide>) => onChange({ ...slide, ...patch });
  const dark = slide.layout === "title";
  const dash = <span className="text-signal">—</span>;
  const heading = (
    <div className="border-b border-ink pb-[1.2cqw]">
      <EditableText
        value={slide.title}
        editable={editable}
        single
        className="font-serif text-[3.3cqw] leading-[1.15] text-ink"
        onChange={(v) => set({ title: v })}
      />
    </div>
  );
  let body: JSX.Element;
  switch (slide.layout) {
    case "title":
      body = (
        <div className="flex h-full items-center">
          <div className="flex w-full gap-[3cqw]">
            <div className="w-[0.9cqw] shrink-0 bg-signal" />
            <div className="min-w-0 flex-1 space-y-[1.4cqw]">
              <EditableText
                value={slide.title}
                editable={editable}
                single
                className="font-serif text-[4.6cqw] leading-[1.1] text-paper"
                onChange={(v) => set({ title: v })}
              />
              <EditableText
                value={slide.subtitle}
                editable={editable}
                placeholder="Subtitle"
                className="text-[1.8cqw] text-rule"
                onChange={(v) => set({ subtitle: v })}
              />
            </div>
          </div>
        </div>
      );
      break;
    case "section":
      body = (
        <div className="flex h-full flex-col justify-center gap-[1.4cqw]">
          <EditableText
            value={slide.title}
            editable={editable}
            single
            className="font-serif text-[4.4cqw] leading-[1.1] text-ink"
            onChange={(v) => set({ title: v })}
          />
          <EditableText
            value={slide.subtitle}
            editable={editable}
            placeholder="Subtitle"
            className="text-[1.8cqw] text-graphite"
            onChange={(v) => set({ subtitle: v })}
          />
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
            <EditableText
              value={slide.number}
              editable={editable}
              single
              className="font-serif text-[11cqw] leading-none text-signal"
              onChange={(v) => set({ number: v })}
            />
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
          <EditableText
            value={slide.caption}
            editable={editable}
            placeholder="Caption"
            className="mt-[0.6cqw] text-[1.35cqw] text-graphite"
            onChange={(v) => set({ caption: v })}
          />
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
          <EditableText
            value={slide.caption}
            editable={editable}
            placeholder="Caption"
            className="mt-[0.6cqw] text-[1.35cqw] text-graphite"
            onChange={(v) => set({ caption: v })}
          />
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
        </div>
      );
      break;
    default:
      body = (
        <div className="flex h-full flex-col">
          {heading}
          <EditableList
            items={slide.bullets}
            editable={editable}
            onChange={(v) => set({ bullets: v })}
            className="mt-[2.4cqw] space-y-[1.1cqw] text-[2cqw] text-ink"
            marker={() => dash}
          />
        </div>
      );
  }
  return (
    <div
      style={{ ...CQ, ...brandVars(brand, dark) }}
      className={cx("relative aspect-[16/9] w-full overflow-hidden text-left", dark ? "bg-ink" : "bg-paper")}
    >
      <div className="absolute inset-0 px-[5.2cqw] pb-[4cqw] pt-[3.6cqw]">{body}</div>
      {brand?.logo && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={brand.logo}
          alt=""
          className={cx("absolute w-auto", dark ? "left-[8.2cqw] top-[4.5cqw] h-[5.2cqw]" : "bottom-[1.2cqw] left-[5.2cqw] h-[2.4cqw]")}
        />
      )}
      {!dark && brand?.footer && (
        <span className={cx("absolute bottom-[1.6cqw] font-sans text-[0.9cqw] text-mute", brand.logo ? "left-[14cqw]" : "left-[5.2cqw]")}>
          {brand.footer}
        </span>
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
      <div
        className="absolute bottom-3 right-4 flex items-center gap-4 font-mono text-[11px] text-white/40"
        onClick={(e) => e.stopPropagation()}
      >
        <span>N notes · ← → move · Esc exit</span>
        <span>
          {i + 1} / {slides.length}
        </span>
      </div>
    </div>
  );
}

// ── Editor ──────────────────────────────────────────────────────────────────

const SUGGESTIONS = [
  "Make it shorter",
  "Turn this into a chart",
  "Split into two slides",
  "Write speaker notes",
  "Translate to Bahasa Indonesia",
];

export function DeckEditor({ prefix, onClose }: { prefix: string; onClose: () => void }) {
  const st = useStudio<Deck>(prefix, "deck");
  const [sel, setSel] = useState(0);
  const [presenting, setPresenting] = useState(false);
  const [adding, setAdding] = useState(false);
  const deck = st.data;
  const bk = useBrandKits();
  const kit = bk.pick(deck?.brand_id);
  const slides = deck?.slides ?? [];
  const cur = Math.min(sel, Math.max(0, slides.length - 1));
  const slide = slides[cur];
  const assets = deck?.assets ?? [];
  const layouts = LAYOUTS.filter((l) => l.key !== "image" || assets.length > 0 || slide?.layout === "image");

  const setSlides = (next: Slide[]) => deck && st.update({ ...deck, slides: next });
  const setSlide = (s: Slide) => setSlides(slides.map((x) => (x.id === s.id ? s : x)));
  const move = (d: number) => {
    const j = cur + d;
    if (j < 0 || j >= slides.length) return;
    const next = [...slides];
    [next[cur], next[j]] = [next[j], next[cur]];
    setSlides(next);
    setSel(j);
  };

  const close = useCallback(async () => {
    await st.flush();
    onClose();
  }, [st, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (presenting || ["TEXTAREA", "INPUT", "SELECT"].includes(t.tagName)) return;
      if (e.key === "ArrowDown") setSel((x) => Math.min(slides.length - 1, x + 1));
      if (e.key === "ArrowUp") setSel((x) => Math.max(0, x - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presenting, slides.length]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-sheet">
      <div className="flex items-center gap-3 border-b border-ink bg-paper px-4 py-2">
        <button onClick={close} className="whitespace-nowrap text-[12.5px] text-graphite hover:text-ink">
          ← Back to task
        </button>
        <span className="h-4 w-px bg-rule" />
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-signal">Deck</span>
        <div className="min-w-0 flex-1">
          {deck && (
            <EditableText
              value={deck.title}
              single
              className="truncate font-serif text-[17px] text-ink"
              onChange={(v) => st.update({ ...deck, title: v })}
            />
          )}
        </div>
        <SaveBadge state={st.state} busy={st.busy} />
        <ShareButton createUrl={`${prefix}/deck/share`} listUrl={`${prefix}/deck/shares`} />
        <BrandMenu
          current={kit}
          kits={bk.kits}
          fonts={bk.fonts}
          reload={bk.reload}
          onPick={(id) => deck && st.update({ ...deck, brand_id: id })}
        />
        <HistoryMenu load={st.versions} onRestore={(v) => void st.restore(v)} onRebuild={() => void st.rebuild()} />
        <Button size="sm" tone="line" disabled={!deck} onClick={() => void st.download("pptx")}>
          Export .pptx
        </Button>
        <Button size="sm" tone="signal" disabled={!slides.length} onClick={() => setPresenting(true)}>
          ▶ Present
        </Button>
      </div>
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
          {st.state === "loading"
            ? "Preparing the deck from the report… the first time can take a minute or two."
            : "Couldn't open the deck."}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[190px_minmax(0,1fr)_300px]">
          <div className="overflow-y-auto border-r border-rule bg-paper p-3">
            <ol className="space-y-2.5">
              {slides.map((s, i) => (
                <li key={s.id} className="flex gap-1.5">
                  <span className="w-4 pt-0.5 text-right font-mono text-[10px] text-mute">{i + 1}</span>
                  <button
                    onClick={() => setSel(i)}
                    className={cx(
                      "block min-w-0 flex-1 border-2 transition-colors",
                      i === cur ? "border-signal" : "border-transparent hover:border-rule",
                    )}
                    aria-label={`Slide ${i + 1}: ${s.title}`}
                  >
                    <div className="pointer-events-none">
                      <SlideCanvas slide={s} n={i + 1} brand={kit} />
                    </div>
                  </button>
                </li>
              ))}
            </ol>
            <div className="relative mt-3">
              <Button size="sm" tone="line" className="w-full" onClick={() => setAdding((a) => !a)}>
                + New slide
              </Button>
              {adding && (
                <div className="absolute inset-x-0 bottom-9 z-10 grid grid-cols-2 gap-1 border border-ink bg-white p-1.5 shadow-lg">
                  {layouts.map((l) => (
                    <button
                      key={l.key}
                      onClick={() => {
                        const next = [...slides];
                        next.splice(cur + 1, 0, blankSlide(l.key, assets));
                        setSlides(next);
                        setSel(cur + 1);
                        setAdding(false);
                      }}
                      className="border border-rule px-1.5 py-1 text-[11px] hover:border-ink"
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="min-w-0 overflow-y-auto px-8 py-6">
            {slide && (
              <div className="mx-auto max-w-[980px]">
                <div className="mb-2 flex items-center gap-1 text-[11.5px] text-graphite">
                  <span className="mr-auto font-mono text-[10.5px] text-mute">
                    Slide {cur + 1} of {slides.length} · click any text to edit · Ctrl+B bold · Ctrl+I italic
                  </span>
                  <Button size="sm" tone="quiet" disabled={cur === 0} onClick={() => move(-1)} title="Move up">
                    ↑
                  </Button>
                  <Button size="sm" tone="quiet" disabled={cur === slides.length - 1} onClick={() => move(1)} title="Move down">
                    ↓
                  </Button>
                  <Button
                    size="sm"
                    tone="quiet"
                    onClick={() => {
                      const next = [...slides];
                      next.splice(cur + 1, 0, { ...structuredClone(slide), id: newId() });
                      setSlides(next);
                      setSel(cur + 1);
                    }}
                  >
                    Duplicate
                  </Button>
                  <Button
                    size="sm"
                    tone="quiet"
                    disabled={slides.length <= 1}
                    onClick={() => {
                      setSlides(slides.filter((x) => x.id !== slide.id));
                      setSel(Math.max(0, cur - 1));
                    }}
                  >
                    Delete
                  </Button>
                </div>
                <div className="shadow-[0_18px_40px_-18px_rgb(var(--ink)/0.45)] ring-1 ring-ink/80">
                  <SlideCanvas key={slide.id} slide={slide} n={cur + 1} editable onChange={setSlide} brand={kit} />
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
            {slide && (
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
              </div>
            )}
            {slide?.layout === "image" && (
              <div>
                <div className="label mb-2">Chart image</div>
                <ImagePicker
                  assets={assets}
                  value={slide.image}
                  onPick={(a) => setSlide({ ...slide, image: a.url, caption: slide.caption || a.note })}
                />
              </div>
            )}
            {slide?.layout === "chart" && slide.chart && (
              <div>
                <div className="label mb-2">Chart data</div>
                <ChartEditor chart={slide.chart} onChange={(c) => setSlide({ ...slide, chart: c })} />
              </div>
            )}
            <AiBox
              noun="slide"
              hasTarget={!!slide}
              suggestions={SUGGESTIONS}
              busy={!!st.busy}
              onRun={(text, whole) => st.ai(text, whole ? "" : slide?.id)}
            />
          </div>
        </div>
      )}

      {presenting && slides.length > 0 && <Present slides={slides} start={cur} onClose={() => setPresenting(false)} brand={kit} />}
    </div>
  );
}
