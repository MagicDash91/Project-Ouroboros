"use client";

import { useCallback, useState } from "react";
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
  type Block,
  type BlockType,
  type Doc,
} from "./shared";
import { ShareButton } from "./ShareDialog";
import { BrandMenu, brandVars, useBrandKits } from "./brand";

/* A report (Agent task or Analytics run) as an editable document: click to edit, add / convert / reorder blocks,
   edit tables and chart data, ask Claude to rewrite a block or the whole document,
   export Word (.docx) or PDF. */

const TYPES: { key: BlockType; label: string }[] = [
  { key: "paragraph", label: "Text" },
  { key: "heading", label: "Heading" },
  { key: "bullets", label: "Bullets" },
  { key: "numbered", label: "Numbered" },
  { key: "table", label: "Table" },
  { key: "chart", label: "Chart" },
  { key: "quote", label: "Quote" },
  { key: "image", label: "Chart image" },
];

function blankBlock(type: BlockType, assets: Asset[] = []): Block {
  if (type === "image") return { id: newId(), type, image: assets[0]?.url ?? "", caption: assets[0] ? `**${assets[0].title}**` : "" };
  if (type === "heading") return { id: newId(), type, level: 2, text: "" };
  if (type === "bullets" || type === "numbered") return { id: newId(), type, items: [""] };
  if (type === "table") return { id: newId(), type, table: emptyTable(), caption: "" };
  if (type === "chart") return { id: newId(), type, chart: emptyChart(), caption: "" };
  return { id: newId(), type, text: "" };
}

/** Change a block's type, carrying its text across where that makes sense. */
function convert(b: Block, type: BlockType): Block {
  if (type === b.type) return b;
  const text = b.text ?? (b.items ?? []).join(" ");
  if (type === "heading" || type === "paragraph" || type === "quote")
    return { id: b.id, type, text, ...(type === "heading" ? { level: 2 } : {}) };
  if (type === "bullets" || type === "numbered")
    return { id: b.id, type, items: b.items ?? (text ? text.split(/(?<=[.!?])\s+/).filter(Boolean) : [""]) };
  return { ...blankBlock(type), id: b.id };
}

export function BlockView({ b, onChange, editable = true }: { b: Block; onChange: (b: Block) => void; editable?: boolean }) {
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
          marker={(i) =>
            b.type === "bullets" ? (
              <span className="text-signal">•</span>
            ) : (
              <span className="font-mono text-[12px] text-mute">{i + 1}.</span>
            )
          }
        />
      );
    case "table":
      return (
        <div>
          <TableBlock
            table={b.table!}
            editable={editable}
            onChange={(t) => onChange({ ...b, table: t })}
            className="overflow-x-auto text-[13px] text-ink"
          />
          <EditableText
            editable={editable}
            value={b.caption ?? ""}
            placeholder="Caption (optional)"
            className="mt-1 text-[12px] italic text-graphite"
            onChange={(v) => onChange({ ...b, caption: v })}
          />
        </div>
      );
    case "image":
      return (
        <figure>
          {b.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={b.image} alt="" className="mx-auto max-h-[460px] w-full object-contain" />
          ) : (
            <div className="grid h-40 place-items-center border border-dashed border-rule text-[12px] text-mute">
              Pick a chart in the side panel
            </div>
          )}
          <EditableText
            editable={editable}
            value={b.caption ?? ""}
            placeholder="Caption (optional)"
            className="mt-1 text-[12px] italic text-graphite"
            onChange={(v) => onChange({ ...b, caption: v })}
          />
        </figure>
      );
    case "chart":
      return (
        <div>
          <div className="aspect-[2/1] w-full">
            <MiniChart chart={b.chart!} />
          </div>
          <EditableText
            editable={editable}
            value={b.caption ?? ""}
            placeholder="Caption (optional)"
            className="mt-1 text-[12px] italic text-graphite"
            onChange={(v) => onChange({ ...b, caption: v })}
          />
        </div>
      );
    default:
      return (
        <EditableText
          editable={editable}
          value={b.text ?? ""}
          placeholder="Type here"
          className="text-[15px] leading-[1.7] text-ink"
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

export function DocEditor({ prefix, onClose }: { prefix: string; onClose: () => void }) {
  const st = useStudio<Doc>(prefix, "doc");
  const [selId, setSelId] = useState<string | null>(null);
  const doc = st.data;
  const bk = useBrandKits();
  const kit = bk.pick(doc?.brand_id);
  const blocks = doc?.blocks ?? [];
  const idx = blocks.findIndex((b) => b.id === selId);
  const sel = idx >= 0 ? blocks[idx] : null;
  const assets = doc?.assets ?? [];
  const types = TYPES.filter((t) => t.key !== "image" || assets.length > 0);

  const setBlocks = (next: Block[]) => doc && st.update({ ...doc, blocks: next });
  const setBlock = (b: Block) => setBlocks(blocks.map((x) => (x.id === b.id ? b : x)));
  const insertAfter = (i: number, type: BlockType) => {
    const b = blankBlock(type, assets);
    setBlocks([...blocks.slice(0, i + 1), b, ...blocks.slice(i + 1)]);
    setSelId(b.id);
  };
  const move = (d: number) => {
    const j = idx + d;
    if (idx < 0 || j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    [next[idx], next[j]] = [next[j], next[idx]];
    setBlocks(next);
  };

  const close = useCallback(async () => {
    await st.flush();
    onClose();
  }, [st, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-sheet">
      <div className="flex items-center gap-3 border-b border-ink bg-paper px-4 py-2">
        <button onClick={close} className="whitespace-nowrap text-[12.5px] text-graphite hover:text-ink">
          ← Back to task
        </button>
        <span className="h-4 w-px bg-rule" />
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-signal">Document</span>
        <div className="min-w-0 flex-1 truncate font-serif text-[17px] text-ink">{doc?.title}</div>
        <SaveBadge state={st.state} busy={st.busy} />
        <ShareButton createUrl={`${prefix}/doc/share`} listUrl={`${prefix}/doc/shares`} />
        <BrandMenu
          current={kit}
          kits={bk.kits}
          fonts={bk.fonts}
          reload={bk.reload}
          onPick={(id) => doc && st.update({ ...doc, brand_id: id })}
        />
        <HistoryMenu load={st.versions} onRestore={(v) => void st.restore(v)} onRebuild={() => void st.rebuild()} />
        <Button size="sm" tone="line" disabled={!doc} onClick={() => void st.download("docx")}>
          Export Word
        </Button>
        <Button size="sm" tone="line" disabled={!doc} onClick={() => void st.download("pdf")}>
          Export PDF
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

      {!doc ? (
        <div className="grid flex-1 place-items-center text-[13px] text-mute">
          {st.state === "loading" ? "Opening the document… the first time can take a few seconds." : "Couldn't open the document."}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0 overflow-y-auto px-6 py-8" onClick={() => setSelId(null)}>
            <article
              style={{ ...brandVars(kit), ...(kit && !kit.builtin ? { background: kit.background } : {}) }}
              className="mx-auto max-w-[780px] bg-white px-14 py-12 shadow-[0_18px_40px_-22px_rgb(var(--ink)/0.45)] ring-1 ring-rule"
            >
              {kit?.logo && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={kit.logo} alt="" className="mb-6 h-10 w-auto" />
              )}
              <EditableText
                value={doc.title}
                single
                className="font-serif text-[34px] leading-[1.1] text-ink"
                onChange={(v) => st.update({ ...doc, title: v })}
              />
              <p className="mb-8 mt-2 text-[11.5px] text-mute">
                Prepared with Ouroboros · click any text to edit · Ctrl+B bold · Ctrl+I italic
              </p>
              <div className="space-y-3">
                {blocks.map((b, i) => (
                  <div
                    key={b.id}
                    onMouseDownCapture={() => setSelId(b.id)}
                    onFocusCapture={() => setSelId(b.id)}
                    onClick={(e) => e.stopPropagation()}
                    className={cx(
                      "relative -mx-3 rounded-[2px] px-3 py-0.5",
                      b.id === selId ? "bg-signal/[0.04] ring-1 ring-signal/40" : "hover:bg-ink/[0.02]",
                    )}
                  >
                    <BlockView b={b} onChange={setBlock} />
                    {b.id === selId && (
                      <div
                        className="absolute -bottom-3 left-3 z-10 flex gap-0.5 border border-ink bg-white px-1 py-0.5 shadow-sm"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <span className="px-1 text-[10.5px] text-mute">Insert below:</span>
                        {types.map((t) => (
                          <button
                            key={t.key}
                            onClick={() => insertAfter(i, t.key)}
                            className="px-1 text-[10.5px] text-graphite hover:text-signal"
                          >
                            {t.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-10 flex flex-wrap items-center gap-1 border-t border-rule pt-3 opacity-70 hover:opacity-100">
                <span className="mr-1 text-[11px] text-mute">Add at the end:</span>
                {types.map((t) => (
                  <button
                    key={t.key}
                    onClick={(e) => {
                      e.stopPropagation();
                      insertAfter(blocks.length - 1, t.key);
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
                  {types.map((t) => (
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
                {sel.type === "heading" && (
                  <div className="flex gap-1">
                    {[1, 2, 3].map((l) => (
                      <button
                        key={l}
                        onClick={() => setBlock({ ...sel, level: l })}
                        className={cx(
                          "flex-1 border px-2 py-1 text-[11px]",
                          sel.level === l ? "border-ink bg-ink text-paper" : "border-rule bg-white hover:border-ink",
                        )}
                      >
                        H{l}
                      </button>
                    ))}
                  </div>
                )}
                <div className="flex gap-1">
                  <Button size="sm" tone="quiet" disabled={idx === 0} onClick={() => move(-1)}>
                    ↑ Up
                  </Button>
                  <Button size="sm" tone="quiet" disabled={idx === blocks.length - 1} onClick={() => move(1)}>
                    ↓ Down
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
                {sel.type === "image" && (
                  <div>
                    <div className="label mb-2">Chart image</div>
                    <ImagePicker assets={assets} value={sel.image ?? ""} onPick={(a) => setBlock({ ...sel, image: a.url })} />
                  </div>
                )}
                {sel.type === "chart" && sel.chart && (
                  <div>
                    <div className="label mb-2">Chart data</div>
                    <ChartEditor chart={sel.chart} onChange={(c) => setBlock({ ...sel, chart: c })} />
                  </div>
                )}
              </div>
            ) : (
              <p className="text-[12px] leading-relaxed text-mute">
                Click a block to change its type, move it, or ask the AI to rewrite just that part.
              </p>
            )}
            <AiBox
              noun="block"
              hasTarget={!!sel}
              suggestions={SUGGESTIONS}
              busy={!!st.busy}
              onRun={(text, whole) => st.ai(text, whole ? "" : (sel?.id ?? ""))}
            />
          </div>
        </div>
      )}
    </div>
  );
}
