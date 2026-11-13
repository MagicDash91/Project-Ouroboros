"use client";

import { useCallback, useState } from "react";
import { Button, cx } from "../ui";
import {
  AiBox,
  ChartEditor,
  EditableList,
  EditableText,
  Explanation,
  HistoryMenu,
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
  type Block,
  type BlockType,
  type Doc,
  type TextStyle,
} from "./shared";
import { FormatGroups, Group, HistoryGroup, Icon, PicturePicker, Pop, RButton, Ribbon, Sep, TablePicker, tableOf } from "./Ribbon";
import { ShareButton } from "./ShareDialog";
import { BrandMenu, brandVars, useBrandKits } from "./brand";

/* A report as an editable document, like a word processor: a ribbon with fonts, sizes, colours, highlight,
   alignment and lists; insert tables (size grid), pictures (upload or the report's charts), charts,
   dividers and page breaks; undo / redo; AI rewrites of a block or the whole document; Word / PDF export. */

const TYPES: { key: BlockType; label: string }[] = [
  { key: "paragraph", label: "Text" },
  { key: "heading", label: "Heading" },
  { key: "bullets", label: "Bullets" },
  { key: "numbered", label: "Numbered" },
  { key: "table", label: "Table" },
  { key: "chart", label: "Chart" },
  { key: "quote", label: "Quote" },
  { key: "image", label: "Picture" },
  { key: "divider", label: "Divider" },
  { key: "page_break", label: "Page break" },
];
const TEXT_TYPES: BlockType[] = ["paragraph", "heading", "quote", "bullets", "numbered"];
const STYLES: { label: string; type: BlockType; level?: number }[] = [
  { label: "Normal", type: "paragraph" },
  { label: "Heading 1", type: "heading", level: 1 },
  { label: "Heading 2", type: "heading", level: 2 },
  { label: "Heading 3", type: "heading", level: 3 },
  { label: "Quote", type: "quote" },
];

function blankBlock(type: BlockType, assets: Asset[] = []): Block {
  if (type === "image") return { id: newId(), type, image: assets[0]?.url ?? "", caption: "", width: 100, align: "center" };
  if (type === "heading") return { id: newId(), type, level: 2, text: "" };
  if (type === "bullets" || type === "numbered") return { id: newId(), type, items: [""] };
  if (type === "table") return { id: newId(), type, table: emptyTable(), caption: "" };
  if (type === "chart") return { id: newId(), type, chart: emptyChart(), caption: "" };
  if (type === "divider" || type === "page_break") return { id: newId(), type };
  return { id: newId(), type, text: "" };
}

/** Change a block's type, carrying its text and formatting across where that makes sense. */
function convert(b: Block, type: BlockType, level?: number): Block {
  if (type === b.type && (type !== "heading" || level === undefined || level === b.level)) return b;
  const text = b.text ?? (b.items ?? []).join(" ");
  const style = b.style;
  if (type === "heading" || type === "paragraph" || type === "quote")
    return { id: b.id, type, text, style, ...(type === "heading" ? { level: level ?? 2 } : {}) };
  if (type === "bullets" || type === "numbered")
    return { id: b.id, type, style, items: b.items ?? (text ? text.split(/(?<=[.!?])\s+/).filter(Boolean) : [""]) };
  return { ...blankBlock(type), id: b.id };
}

// ── Sections (a heading and everything under it, like Word's Navigation pane) ──

const levelOf = (b: Block) => (b.type === "heading" ? (b.level ?? 2) : 99);

/** End (exclusive) of the section that starts at block `s`: up to the next heading of the same or higher level. */
function sectionEnd(blocks: Block[], s: number): number {
  const L = levelOf(blocks[s]);
  let e = s + 1;
  while (e < blocks.length && levelOf(blocks[e]) > L) e++;
  return e;
}

/** The section a block belongs to: [start heading, end), or just the block when no heading precedes it. */
function sectionOf(blocks: Block[], i: number): [number, number] {
  let h = i;
  while (h >= 0 && blocks[h].type !== "heading") h--;
  return h < 0 ? [i, i + 1] : [h, sectionEnd(blocks, h)];
}

/** Move the section starting at heading `s` above the previous section / below the next one of its level. */
function moveSection(blocks: Block[], s: number, dir: -1 | 1): Block[] {
  const e = sectionEnd(blocks, s);
  const L = levelOf(blocks[s]);
  const sec = blocks.slice(s, e);
  if (dir < 0) {
    if (s === 0) return blocks;
    let p = s - 1;
    while (p > 0 && levelOf(blocks[p]) > L) p--;
    return [...blocks.slice(0, p), ...sec, ...blocks.slice(p, s), ...blocks.slice(e)];
  }
  if (e >= blocks.length) return blocks;
  const e2 = sectionEnd(blocks, e);
  return [...blocks.slice(0, s), ...blocks.slice(e, e2), ...sec, ...blocks.slice(e2)];
}

/** Drag and drop: put the section (or single block) starting at `s` before index `t` (t = length → the end). */
function moveSectionTo(blocks: Block[], s: number, t: number): Block[] {
  const e = sectionEnd(blocks, s);
  if (t >= s && t <= e) return blocks;
  const sec = blocks.slice(s, e);
  const rest = [...blocks.slice(0, s), ...blocks.slice(e)];
  const at = t > s ? t - (e - s) : t;
  return [...rest.slice(0, at), ...sec, ...rest.slice(at)];
}

const plainTitle = (t?: string) => (t ?? "").replace(/\{\{[^|]*\|/g, "").replace(/\}\}|\*\*|\*|\+\+|~~/g, "").trim();

function Caption({ b, onChange, editable }: { b: Block; onChange: (b: Block) => void; editable: boolean }) {
  return (
    <>
      <EditableText
        editable={editable}
        value={b.caption ?? ""}
        placeholder="Caption (optional)"
        className="mt-1 text-[12px] italic text-graphite"
        style={{ textAlign: b.align ?? "center" }}
        onChange={(v) => onChange({ ...b, caption: v })}
      />
      <Explanation conclusion={b.conclusion} action={b.action} editable={editable} onChange={(p) => onChange({ ...b, ...p })} />
    </>
  );
}

const JUSTIFY = { left: "flex-start", center: "center", right: "flex-end" } as const;

export function BlockView({ b, onChange, editable = true }: { b: Block; onChange: (b: Block) => void; editable?: boolean }) {
  const css = styleCss(b.style);
  switch (b.type) {
    case "heading": {
      const size = b.level === 1 ? "mt-6 text-[26px]" : b.level === 3 ? "mt-3 font-sans text-[16px] font-semibold" : "mt-5 text-[21px]";
      return (
        <EditableText
          editable={editable}
          value={b.text ?? ""}
          single
          placeholder="Heading"
          className={cx("font-serif leading-tight text-ink", size)}
          style={css}
          onChange={(v) => onChange({ ...b, text: v })}
        />
      );
    }
    case "quote":
      return (
        <div className="border-l-2 border-signal pl-4">
          <EditableText
            editable={editable}
            value={b.text ?? ""}
            placeholder="Quote"
            className="font-serif text-[17px] italic leading-relaxed text-graphite"
            style={css}
            onChange={(v) => onChange({ ...b, text: v })}
          />
        </div>
      );
    case "bullets":
    case "numbered":
      return (
        <EditableList
          items={b.items ?? []}
          editable={editable}
          onChange={(v) => onChange({ ...b, items: v })}
          className="space-y-1.5 text-[15px] leading-relaxed text-ink"
          style={css}
          marker={(i) =>
            b.type === "bullets" ? <span className="text-signal">•</span> : <span className="font-mono text-[12px] text-mute">{i + 1}.</span>
          }
        />
      );
    case "divider":
      return <hr className="my-3 border-0 border-t border-rule" />;
    case "page_break":
      return (
        <div className="my-2 flex items-center gap-2 text-[10.5px] uppercase tracking-[0.12em] text-mute">
          <span className="h-px flex-1 border-t border-dashed border-rule" />
          Page break
          <span className="h-px flex-1 border-t border-dashed border-rule" />
        </div>
      );
    case "table":
      return (
        <div style={css}>
          <TableBlock table={b.table!} editable={editable} onChange={(t) => onChange({ ...b, table: t })} className="overflow-x-auto text-[13px] text-ink" />
          <Caption b={b} onChange={onChange} editable={editable} />
        </div>
      );
    case "image":
      return (
        <figure>
          <div className="flex" style={{ justifyContent: JUSTIFY[b.align ?? "center"] }}>
            {b.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={b.image} alt={b.caption || ""} className="max-h-[560px] object-contain" style={{ width: `${b.width ?? 100}%` }} />
            ) : (
              <div className="grid h-40 w-full place-items-center border border-dashed border-rule text-[12px] text-mute">
                Use Insert → Picture to add one
              </div>
            )}
          </div>
          <Caption b={b} onChange={onChange} editable={editable} />
        </figure>
      );
    case "chart":
      return (
        <div>
          <div className="aspect-[2/1] w-full">
            <MiniChart chart={b.chart!} />
          </div>
          <Caption b={b} onChange={onChange} editable={editable} />
        </div>
      );
    default:
      return (
        <EditableText
          editable={editable}
          value={b.text ?? ""}
          placeholder="Type here"
          className="text-[15px] leading-[1.7] text-ink"
          style={css}
          onChange={(v) => onChange({ ...b, text: v })}
        />
      );
  }
}

const SUGGESTIONS = [
  "Make it more concise",
  "Rewrite for executives",
  "Turn this table into a chart",
  "Fix grammar and tone",
  "Translate to Bahasa Indonesia",
];

export function DocEditor({ prefix, onClose, backLabel = "← Back" }: { prefix: string; onClose: () => void; backLabel?: string }) {
  const st = useStudio<Doc>(prefix, "doc");
  const [selId, setSelId] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(true);
  const [drag, setDrag] = useState<{ kind: "section" | "block"; from: number } | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const doc = st.data;
  const bk = useBrandKits();
  const kit = bk.pick(doc?.brand_id);
  const blocks = doc?.blocks ?? [];
  const idx = blocks.findIndex((b) => b.id === selId);
  const sel = idx >= 0 ? blocks[idx] : null;
  const assets = doc?.assets ?? [];
  const isText = !!sel && TEXT_TYPES.includes(sel.type);

  const setBlocks = (next: Block[]) => doc && st.update({ ...doc, blocks: next });
  const setBlock = (b: Block) => setBlocks(blocks.map((x) => (x.id === b.id ? b : x)));
  /** Insert after the selected block (or at the end) and select it. */
  const insert = (b: Block, after = idx) => {
    const at = after >= 0 ? after + 1 : blocks.length;
    setBlocks([...blocks.slice(0, at), b, ...blocks.slice(at)]);
    setSelId(b.id);
  };
  const moveBlock = (i: number, d: number) => {
    const j = i + d;
    if (i < 0 || j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    [next[i], next[j]] = [next[j], next[i]];
    setBlocks(next);
  };
  const move = (d: number) => moveBlock(idx, d);
  const removeBlock = (i: number) => {
    setBlocks(blocks.filter((_, k) => k !== i));
    if (blocks[i]?.id === selId) setSelId(null);
  };
  const duplicateBlock = (i: number) => {
    const copy = { ...structuredClone(blocks[i]), id: newId() };
    setBlocks([...blocks.slice(0, i + 1), copy, ...blocks.slice(i + 1)]);
    setSelId(copy.id);
  };
  // The section around the selection (a heading and everything under it).
  const [secStart, secEnd] = idx >= 0 ? sectionOf(blocks, idx) : [-1, -1];
  const inSection = secStart >= 0 && blocks[secStart]?.type === "heading";
  const removeSection = (s: number) => {
    const e = sectionEnd(blocks, s);
    const name = plainTitle(blocks[s].text) || "this section";
    if (!window.confirm(`Delete the section “${name}” and everything in it (${e - s} blocks)? You can undo with Ctrl+Z.`)) return;
    setBlocks([...blocks.slice(0, s), ...blocks.slice(e)]);
    setSelId(null);
  };
  const duplicateSection = (s: number) => {
    const e = sectionEnd(blocks, s);
    const copy = blocks.slice(s, e).map((b) => ({ ...structuredClone(b), id: newId() }));
    setBlocks([...blocks.slice(0, e), ...copy, ...blocks.slice(e)]);
    setSelId(copy[0].id);
  };
  const shiftSection = (s: number, dir: -1 | 1) => setBlocks(moveSection(blocks, s, dir));
  const headings = blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.type === "heading");
  const jumpTo = (id: string) => {
    setSelId(id);
    document.getElementById(`blk-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const drop = (t: number) => {
    if (drag) setBlocks(moveSectionTo(blocks, drag.from, t));
    setDrag(null);
    setDropAt(null);
  };
  const patchStyle = (b: Block, patch: Partial<TextStyle>): Block => {
    const merged: TextStyle = { ...(b.style ?? {}), ...patch };
    (Object.keys(merged) as (keyof TextStyle)[]).forEach((k) => merged[k] === undefined && delete merged[k]);
    return { ...b, style: merged };
  };
  const onStyle = !sel
    ? undefined
    : isText || sel.type === "table"
      ? (patch: Partial<TextStyle>) => setBlock(patchStyle(sel, patch))
      : sel.type === "chart" || sel.type === "image"
        ? (patch: Partial<TextStyle>) => {
            if (patch.align && patch.align !== "justify") setBlock({ ...sel, align: patch.align });
          }
        : undefined;

  const close = useCallback(async () => {
    await st.flush();
    onClose();
  }, [st, onClose]);

  const styleName = sel ? (STYLES.find((s) => s.type === sel.type && (s.type !== "heading" || s.level === sel.level))?.label ?? "") : "";

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
              <Group label="Style">
                <select
                  aria-label="Paragraph style"
                  disabled={!isText}
                  value={styleName}
                  onChange={(e) => {
                    const s = STYLES.find((x) => x.label === e.target.value);
                    if (sel && s) setBlock(convert(sel, s.type, s.level));
                  }}
                  className="h-7 w-[110px] border border-rule bg-white px-1 text-[12px] disabled:opacity-40"
                >
                  <option value="" disabled>
                    —
                  </option>
                  {STYLES.map((s) => (
                    <option key={s.label}>{s.label}</option>
                  ))}
                </select>
              </Group>
              <Sep />
              <FormatGroups style={isText || sel?.type === "table" ? sel?.style : undefined} onStyle={onStyle} />
              <Sep />
              <Group label="Lists">
                <RButton
                  title="Bulleted list"
                  disabled={!isText}
                  active={sel?.type === "bullets"}
                  onClick={() => sel && setBlock(convert(sel, sel.type === "bullets" ? "paragraph" : "bullets"))}
                >
                  <Icon d={["M9 6h11", "M9 12h11", "M9 18h11", "M4 6h.01", "M4 12h.01", "M4 18h.01"]} />
                </RButton>
                <RButton
                  title="Numbered list"
                  disabled={!isText}
                  active={sel?.type === "numbered"}
                  onClick={() => sel && setBlock(convert(sel, sel.type === "numbered" ? "paragraph" : "numbered"))}
                >
                  <Icon d={["M10 6h10", "M10 12h10", "M10 18h10", "M4 5l1-1v4", "M4 11h2l-2 2h2", "M4 17h2v2H4"]} />
                </RButton>
              </Group>
              <Sep />
              <Group label="Block">
                <RButton title="Move block up" disabled={idx <= 0} onClick={() => move(-1)}>
                  <Icon d={["M12 19V5", "M6 11l6-6 6 6"]} />
                </RButton>
                <RButton title="Move block down" disabled={idx < 0 || idx >= blocks.length - 1} onClick={() => move(1)}>
                  <Icon d={["M12 5v14", "M6 13l6 6 6-6"]} />
                </RButton>
                <RButton title="Delete block" disabled={idx < 0} onClick={() => removeBlock(idx)}>
                  <Icon d={["M5 7h14", "M10 7V5h4v2", "M7 7l1 12h8l1-12"]} />
                </RButton>
              </Group>
              <Sep />
              <Group label="Section">
                <RButton title="Move section up (the heading and everything under it)" wide disabled={!inSection} onClick={() => shiftSection(secStart, -1)}>
                  <Icon d={["M12 19V5", "M6 11l6-6 6 6"]} />§
                </RButton>
                <RButton title="Move section down" wide disabled={!inSection || secEnd >= blocks.length} onClick={() => shiftSection(secStart, 1)}>
                  <Icon d={["M12 5v14", "M6 13l6 6 6-6"]} />§
                </RButton>
                <RButton title="Duplicate section" disabled={!inSection} onClick={() => duplicateSection(secStart)}>
                  <Icon d={["M8 8h11v11H8z", "M5 16V5h11"]} />
                </RButton>
                <RButton title="Delete section" disabled={!inSection} onClick={() => removeSection(secStart)}>
                  <Icon d={["M5 7h14", "M10 7V5h4v2", "M7 7l1 12h8l1-12"]} />
                </RButton>
              </Group>
              <Sep />
              <Group label="Visuals">
                <RButton
                  title="Write a Conclusion and an Actionable insight for every chart, table and picture that lacks one (3 credits)"
                  wide
                  disabled={!!st.busy}
                  onClick={() => void st.explain(false)}
                >
                  ✨ Explain visuals
                </RButton>
                <RButton title="Rewrite the Conclusion and Actionable insight of every visual (3 credits)" wide disabled={!!st.busy} onClick={() => void st.explain(true)}>
                  Rewrite all
                </RButton>
              </Group>
              <Sep />
              <Group label="View">
                <RButton title="Navigation pane: your sections, to move, reorder (drag) or delete" wide active={navOpen} onClick={() => setNavOpen((o) => !o)}>
                  <Icon d={["M4 5h6v14H4z", "M14 7h6", "M14 12h6", "M14 17h6"]} />
                  Navigation
                </RButton>
              </Group>
            </>
          ),
        },
        {
          key: "insert",
          label: "Insert",
          content: (
            <>
              <Group label="Text">
                <RButton title="Paragraph" wide onClick={() => insert(blankBlock("paragraph"))}>
                  ¶ Text
                </RButton>
                <RButton title="Heading" wide onClick={() => insert(blankBlock("heading"))}>
                  H Heading
                </RButton>
                <RButton title="Quote" wide onClick={() => insert(blankBlock("quote"))}>
                  “ Quote
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
                        insert({ ...blankBlock("table"), table: tableOf(r, c) });
                        done();
                      }}
                    />
                  )}
                </Pop>
              </Group>
              <Sep />
              <Group label="Illustrations">
                <PicturePicker
                  assets={assets}
                  onError={st.setError}
                  onPick={(url, title) => insert({ ...blankBlock("image"), image: url, caption: title ? `*${title}*` : "" })}
                />
                <RButton title="Chart (edit its data on the right)" wide onClick={() => insert(blankBlock("chart"))}>
                  <Icon d={["M4 20V10", "M10 20V4", "M16 20v-7", "M3 20h18"]} />
                  Chart
                </RButton>
              </Group>
              <Sep />
              <Group label="Layout">
                <RButton title="Divider line" wide onClick={() => insert(blankBlock("divider"))}>
                  — Divider
                </RButton>
                <RButton title="Page break (starts a new page in Word / PDF)" wide onClick={() => insert(blankBlock("page_break"))}>
                  ⤓ Page break
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
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-signal">Document</span>
        <div className="min-w-0 flex-1 truncate font-serif text-[17px] text-ink">{doc?.title}</div>
        <SaveBadge state={st.state} busy={st.busy} />
        <ShareButton createUrl={`${prefix}/doc/share`} listUrl={`${prefix}/doc/shares`} />
        <BrandMenu current={kit} kits={bk.kits} fonts={bk.fonts} reload={bk.reload} onPick={(id) => doc && st.update({ ...doc, brand_id: id })} />
        <HistoryMenu load={st.versions} onRestore={(v) => void st.restore(v)} onRebuild={() => void st.rebuild()} />
        <Button size="sm" tone="line" disabled={!doc} onClick={() => void st.download("docx")}>
          Export Word
        </Button>
        <Button size="sm" tone="line" disabled={!doc} onClick={() => void st.download("pdf")}>
          Export PDF
        </Button>
      </div>
      {doc && ribbon}
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

      {!doc ? (
        <div className="grid flex-1 place-items-center text-[13px] text-mute">
          {st.state === "loading" ? "Opening the document… the first time can take a few seconds." : "Couldn't open the document."}
        </div>
      ) : (
        <div className={cx("grid min-h-0 flex-1", navOpen ? "grid-cols-[230px_minmax(0,1fr)_300px]" : "grid-cols-[minmax(0,1fr)_300px]")}>
          {navOpen && (
            <nav aria-label="Document sections" className="overflow-y-auto border-r border-rule bg-paper p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="label">Navigation</span>
                <button onClick={() => setNavOpen(false)} className="text-[12px] text-mute hover:text-ink" aria-label="Close navigation">
                  ×
                </button>
              </div>
              {headings.length === 0 ? (
                <p className="text-[11.5px] leading-relaxed text-mute">Add headings (Home → Style → Heading 1-3) to split the document into sections.</p>
              ) : (
                <ol className="space-y-0.5">
                  {headings.map(({ b, i }) => {
                    const e = sectionEnd(blocks, i);
                    const on = idx >= i && idx < e && secStart === i;
                    return (
                      <li
                        key={b.id}
                        draggable
                        onDragStart={(ev) => {
                          ev.dataTransfer.effectAllowed = "move";
                          setDrag({ kind: "section", from: i });
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
                        className={cx(
                          "group flex items-center gap-1 rounded-[2px] py-1 pr-1 text-[12px]",
                          on ? "bg-signal/10 text-ink" : "text-graphite hover:bg-ink/[0.04]",
                          dropAt === i && drag && "border-t-2 border-signal",
                        )}
                        style={{ paddingLeft: 4 + ((b.level ?? 2) - 1) * 12 }}
                      >
                        <span className="cursor-grab select-none text-mute" title="Drag to move this section">
                          ⠿
                        </span>
                        <button onClick={() => jumpTo(b.id)} className={cx("min-w-0 flex-1 truncate text-left", (b.level ?? 2) === 1 && "font-medium")}>
                          {plainTitle(b.text) || "(untitled heading)"}
                        </button>
                        <span className="hidden shrink-0 gap-0.5 group-hover:flex">
                          <button title="Move section up" onClick={() => shiftSection(i, -1)} className="px-0.5 text-mute hover:text-ink">
                            ↑
                          </button>
                          <button title="Move section down" onClick={() => shiftSection(i, 1)} className="px-0.5 text-mute hover:text-ink">
                            ↓
                          </button>
                          <button title="Delete section" onClick={() => removeSection(i)} className="px-0.5 text-mute hover:text-signal">
                            ×
                          </button>
                        </span>
                      </li>
                    );
                  })}
                  {drag && (
                    <li
                      onDragOver={(ev) => {
                        ev.preventDefault();
                        setDropAt(blocks.length);
                      }}
                      onDrop={(ev) => {
                        ev.preventDefault();
                        drop(blocks.length);
                      }}
                      className={cx("mt-1 border border-dashed px-2 py-1.5 text-[11px] text-mute", dropAt === blocks.length ? "border-signal" : "border-rule")}
                    >
                      Drop here to move to the end
                    </li>
                  )}
                </ol>
              )}
              <p className="mt-3 text-[10.5px] leading-relaxed text-mute">Drag a heading to move its whole section. Hover for ↑ ↓ ×.</p>
            </nav>
          )}
          <div className="min-w-0 overflow-y-auto bg-[#e9e6df] px-6 py-8" onClick={() => setSelId(null)}>
            <article
              style={{ ...brandVars(kit), ...(kit && !kit.builtin ? { background: kit.background } : {}) }}
              className="mx-auto max-w-[816px] bg-white px-[72px] py-[64px] shadow-[0_18px_40px_-22px_rgb(var(--ink)/0.45)] ring-1 ring-rule"
            >
              {kit?.logo && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={kit.logo} alt="" className="mb-6 h-10 w-auto" />
              )}
              <EditableText value={doc.title} single className="font-serif text-[34px] leading-[1.1] text-ink" onChange={(v) => st.update({ ...doc, title: v })} />
              <p className="mb-8 mt-2 text-[11.5px] text-mute">Select words and use the ribbon (or Ctrl+B / I / U) · click a block to format all of it</p>
              <div className="space-y-3">
                {blocks.map((b, i) => (
                  <div
                    key={b.id}
                    id={`blk-${b.id}`}
                    onMouseDownCapture={() => setSelId(b.id)}
                    onFocusCapture={() => setSelId(b.id)}
                    onClick={(e) => e.stopPropagation()}
                    onDragOver={(ev) => {
                      if (!drag) return;
                      ev.preventDefault();
                      setDropAt(i);
                    }}
                    onDrop={(ev) => {
                      ev.preventDefault();
                      drop(i);
                    }}
                    className={cx(
                      "group/blk relative -mx-3 rounded-[2px] px-3 py-0.5",
                      b.id === selId ? "bg-signal/[0.04] ring-1 ring-signal/40" : "hover:bg-ink/[0.02]",
                      dropAt === i && drag && "border-t-2 border-signal",
                    )}
                  >
                    {/* Margin handle: drag to move (a heading takes its whole section), or ↑ ↓ ⧉ × */}
                    <div
                      className={cx(
                        "absolute -left-9 top-0 flex flex-col items-center gap-px rounded-[2px] border border-rule bg-white py-0.5 text-[11px] leading-none text-mute shadow-sm",
                        b.id === selId ? "flex" : "hidden group-hover/blk:flex",
                      )}
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      <span
                        draggable
                        onDragStart={(ev) => {
                          ev.dataTransfer.effectAllowed = "move";
                          setDrag({ kind: b.type === "heading" ? "section" : "block", from: i });
                        }}
                        onDragEnd={() => {
                          setDrag(null);
                          setDropAt(null);
                        }}
                        title={b.type === "heading" ? "Drag to move this section" : "Drag to move this block"}
                        className="cursor-grab px-1 py-0.5 hover:text-ink"
                      >
                        ⠿
                      </span>
                      <button title="Move up" disabled={i === 0} onClick={() => moveBlock(i, -1)} className="px-1 py-0.5 hover:text-ink disabled:opacity-30">
                        ↑
                      </button>
                      <button title="Move down" disabled={i === blocks.length - 1} onClick={() => moveBlock(i, 1)} className="px-1 py-0.5 hover:text-ink disabled:opacity-30">
                        ↓
                      </button>
                      <button title="Duplicate" onClick={() => duplicateBlock(i)} className="px-1 py-0.5 hover:text-ink">
                        ⧉
                      </button>
                      <button
                        title={b.type === "heading" ? "Delete this heading only (use Section → Delete for the whole section)" : "Delete block"}
                        onClick={() => removeBlock(i)}
                        className="px-1 py-0.5 hover:text-signal"
                      >
                        ×
                      </button>
                    </div>
                    <BlockView b={b} onChange={setBlock} />
                  </div>
                ))}
                {drag && (
                  <div
                    onDragOver={(ev) => {
                      ev.preventDefault();
                      setDropAt(blocks.length);
                    }}
                    onDrop={(ev) => {
                      ev.preventDefault();
                      drop(blocks.length);
                    }}
                    className={cx("border border-dashed px-3 py-2 text-[11px] text-mute", dropAt === blocks.length ? "border-signal" : "border-rule")}
                  >
                    Drop here to move to the end
                  </div>
                )}
              </div>
              <div className="mt-10 flex flex-wrap items-center gap-1 border-t border-rule pt-3 opacity-70 hover:opacity-100">
                <span className="mr-1 text-[11px] text-mute">Add at the end:</span>
                {TYPES.filter((t) => t.key !== "image").map((t) => (
                  <button
                    key={t.key}
                    onClick={(e) => {
                      e.stopPropagation();
                      insert(blankBlock(t.key, assets), blocks.length - 1);
                    }}
                    className="border border-rule px-1.5 text-[11px] text-graphite hover:border-ink hover:text-ink"
                  >
                    + {t.label}
                  </button>
                ))}
              </div>
              {kit?.footer && <p className="mt-6 border-t border-rule pt-2 font-sans text-[11px] text-mute">{kit.footer}</p>}
            </article>
          </div>

          <div className="space-y-6 overflow-y-auto border-l border-rule bg-paper p-4">
            {sel ? (
              <div className="space-y-3">
                <div className="label">Selected block</div>
                <div className="grid grid-cols-3 gap-1">
                  {TYPES.map((t) => (
                    <button
                      key={t.key}
                      onClick={() => setBlock(convert(sel, t.key))}
                      className={cx(
                        "border px-1.5 py-1 text-[11px]",
                        sel.type === t.key ? "border-ink bg-ink text-paper" : "border-rule bg-white hover:border-ink",
                      )}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                <div className="flex gap-1">
                  <Button size="sm" tone="quiet" disabled={idx === 0} onClick={() => move(-1)}>
                    ↑ Up
                  </Button>
                  <Button size="sm" tone="quiet" disabled={idx === blocks.length - 1} onClick={() => move(1)}>
                    ↓ Down
                  </Button>
                  <Button size="sm" tone="quiet" onClick={() => insert({ ...structuredClone(sel), id: newId() })}>
                    Duplicate
                  </Button>
                  <Button
                    size="sm"
                    tone="quiet"
                    className="ml-auto"
                    onClick={() => {
                      setBlocks(blocks.filter((x) => x.id !== sel.id));
                      setSelId(null);
                    }}
                  >
                    Delete
                  </Button>
                </div>
                {inSection && (
                  <div className="space-y-1.5 border-t border-rule pt-3">
                    <div className="label">Section · {plainTitle(blocks[secStart].text) || "untitled"}</div>
                    <p className="text-[11px] text-mute">The heading and its {secEnd - secStart - 1} block{secEnd - secStart - 1 === 1 ? "" : "s"} below it.</p>
                    <div className="flex flex-wrap gap-1">
                      <Button size="sm" tone="quiet" onClick={() => shiftSection(secStart, -1)} disabled={secStart === 0}>
                        ↑ Move section
                      </Button>
                      <Button size="sm" tone="quiet" onClick={() => shiftSection(secStart, 1)} disabled={secEnd >= blocks.length}>
                        ↓ Move section
                      </Button>
                      <Button size="sm" tone="quiet" onClick={() => duplicateSection(secStart)}>
                        Duplicate section
                      </Button>
                      <Button size="sm" tone="quiet" onClick={() => removeSection(secStart)}>
                        Delete section
                      </Button>
                    </div>
                  </div>
                )}
                {sel.type === "image" && (
                  <div className="space-y-2">
                    <div className="label">Picture</div>
                    <label className="block text-[11.5px] text-graphite">
                      Size: {Math.round(sel.width ?? 100)}% of the page width
                      <input
                        type="range"
                        min={10}
                        max={100}
                        step={5}
                        value={sel.width ?? 100}
                        onChange={(e) => setBlock({ ...sel, width: Number(e.target.value) })}
                        className="mt-1 w-full"
                      />
                    </label>
                    <div className="flex gap-1">
                      {(["left", "center", "right"] as const).map((a) => (
                        <button
                          key={a}
                          onClick={() => setBlock({ ...sel, align: a })}
                          className={cx(
                            "flex-1 border px-2 py-1 text-[11px] capitalize",
                            (sel.align ?? "center") === a ? "border-ink bg-ink text-paper" : "border-rule bg-white hover:border-ink",
                          )}
                        >
                          {a}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-2 text-[11.5px] text-graphite">
                      Replace:
                      <PicturePicker assets={assets} onError={st.setError} onPick={(url) => setBlock({ ...sel, image: url })} />
                    </div>
                  </div>
                )}
                {sel.type === "chart" && sel.chart && (
                  <div>
                    <div className="label mb-2">Chart type and data</div>
                    <ChartEditor chart={sel.chart} onChange={(c) => setBlock({ ...sel, chart: c })} />
                  </div>
                )}
                {sel.type === "table" && (
                  <p className="text-[11.5px] leading-relaxed text-mute">
                    Click a cell to type. “+ row” / “+ column” under the table add more, × deletes. Select text in a cell to format it, or use the
                    ribbon to format the whole table.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-[12px] leading-relaxed text-mute">
                Click a block to format it, change its type, move it, or ask the AI to rewrite just that part. Select words to format only those.
              </p>
            )}
            <AiBox noun="block" hasTarget={!!sel} suggestions={SUGGESTIONS} busy={!!st.busy} onRun={(text, whole) => st.ai(text, whole ? "" : (sel?.id ?? ""))} />
          </div>
        </div>
      )}
    </div>
  );
}
