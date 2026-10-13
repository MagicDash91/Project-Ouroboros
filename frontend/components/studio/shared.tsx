"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { errorText, getJSON, postJSON, putJSON } from "@/lib/api";
import { Button, cx } from "../ui";

/* Shared pieces of the Agent Studio (features/studio.py): types, the load/autosave/AI hook,
   click-to-edit text with **bold** / *italic*, charts, tables and the AI box. */

// ── Types (mirror features/studio.py) ───────────────────────────────────────

export type ChartType = "bar" | "line" | "pie";
export interface ChartData {
  type: ChartType;
  labels: string[];
  series: { name: string; values: (number | null)[] }[];
  unit: string;
}
export interface TableData {
  columns: string[];
  rows: string[][];
}
export type Layout = "title" | "section" | "bullets" | "two_column" | "chart" | "table" | "quote" | "big_number" | "image";
export interface Slide {
  id: string;
  layout: Layout;
  title: string;
  subtitle: string;
  bullets: string[];
  left: string[];
  right: string[];
  left_title: string;
  right_title: string;
  quote: string;
  attribution: string;
  number: string;
  caption: string;
  chart: ChartData | null;
  table: TableData | null;
  image: string;
  notes: string;
}
export type BlockType = "heading" | "paragraph" | "bullets" | "numbered" | "table" | "chart" | "image" | "quote";
export interface Block {
  id: string;
  type: BlockType;
  level?: number;
  text?: string;
  items?: string[];
  table?: TableData;
  chart?: ChartData;
  image?: string;
  caption?: string;
}
interface Meta {
  version: number;
  updated_at: string;
  note: string;
  /** The source has moved on since this version was built (e.g. a chat with new answers). */
  stale?: boolean;
}
/** A chart image from the source (an Analytics run's own charts) that slides and blocks may show. */
export interface Asset {
  url: string;
  title: string;
  note: string;
}
export interface Deck extends Meta {
  kind: "deck";
  title: string;
  slides: Slide[];
  brand_id?: string;
  assets?: Asset[];
}
export interface Doc extends Meta {
  kind: "doc";
  title: string;
  blocks: Block[];
  brand_id?: string;
  assets?: Asset[];
}
export interface Version {
  version: number;
  updated_at: string;
  note: string;
  current: boolean;
}

export const newId = () => Math.random().toString(16).slice(2, 10);
export const emptyChart = (): ChartData => ({
  type: "bar",
  labels: ["A", "B", "C"],
  series: [{ name: "Value", values: [1, 2, 3] }],
  unit: "",
});
export const emptyTable = (): TableData => ({
  columns: ["Column 1", "Column 2"],
  rows: [
    ["", ""],
    ["", ""],
  ],
});

// ── Load, autosave, AI edits, history ───────────────────────────────────────

export type SaveState = "loading" | "saved" | "dirty" | "saving" | "error";

/** `prefix` is the source's studio API, e.g. /api/agent/tasks/<id>/studio or /api/runs/<id>/studio/analytics. */
export function useStudio<T extends Deck | Doc>(prefix: string, kind: T["kind"]) {
  const base = `${prefix}/${kind}`;
  const [data, setData] = useState<T | null>(null);
  const [state, setState] = useState<SaveState>("loading");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(""); // "" or what the AI / history is doing
  const version = useRef(0);
  const latest = useRef<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const saving = useRef<Promise<void> | null>(null);
  const again = useRef(false);

  const adopt = useCallback((d: T) => {
    version.current = d.version;
    latest.current = d;
    setData(d);
    setState("saved");
    setError("");
  }, []);

  useEffect(() => {
    getJSON<T>(base)
      .then(adopt)
      .catch((e) => {
        setError(errorText(e));
        setState("error");
      });
  }, [base, adopt]);

  // One save at a time; edits made while saving go out right after, against the new version.
  const flush = useCallback(async (): Promise<void> => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (saving.current) {
      again.current = true;
      return saving.current;
    }
    const d = latest.current;
    if (!d) return;
    setState("saving");
    saving.current = putJSON<T>(base, { data: d, base_version: version.current })
      .then((res) => {
        version.current = res.version;
        setState(latest.current === d ? "saved" : "dirty");
        setError("");
      })
      .catch((e) => {
        setError(errorText(e));
        setState("error");
      })
      .finally(() => {
        saving.current = null;
        if (again.current) {
          again.current = false;
          void flush();
        }
      });
    return saving.current;
  }, [base]);

  const update = useCallback(
    (next: T) => {
      latest.current = next;
      setData(next);
      setState("dirty");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 800);
    },
    [flush],
  );

  async function run(label: string, call: () => Promise<T>): Promise<boolean> {
    if (timer.current || saving.current) await flush();
    setBusy(label);
    setError("");
    try {
      adopt(await call());
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy("");
    }
  }

  const ai = (instruction: string, targetId = "") =>
    run("Claude is editing…", () => postJSON<T>(`${base}/ai`, { instruction, target_id: targetId }));
  const restore = (v: number) => run(`Restoring version ${v}…`, () => postJSON<T>(`${base}/restore`, { version: v }));
  const rebuild = () => run("Rebuilding from the agent's report…", () => postJSON<T>(`${base}/rebuild`));
  const versions = useCallback(() => getJSON<Version[]>(`${base}/versions`), [base]);
  const reload = () =>
    getJSON<T>(base)
      .then(adopt)
      .catch((e) => setError(errorText(e)));

  /** Save pending edits first, then download the export. */
  async function download(format: string) {
    if (timer.current || saving.current) await flush();
    window.location.href = `${base}/export?format=${format}`;
  }

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (timer.current || saving.current) {
        void flush();
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [flush]);

  return { data, update, state, error, setError, busy, ai, restore, rebuild, versions, download, flush, reload };
}

// ── Inline **bold** / *italic* ──────────────────────────────────────────────

export function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") && p.length > 4 ? (
          <strong key={i} className="font-semibold">
            {p.slice(2, -2)}
          </strong>
        ) : p.startsWith("*") && p.endsWith("*") && p.length > 2 ? (
          <em key={i}>{p.slice(1, -1)}</em>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

function wrapSelection(el: HTMLTextAreaElement, mark: string, onChange: (v: string) => void) {
  const { selectionStart: a, selectionEnd: b, value } = el;
  if (a === b) return;
  onChange(value.slice(0, a) + mark + value.slice(a, b) + mark + value.slice(b));
  requestAnimationFrame(() => el.setSelectionRange(a + mark.length, b + mark.length));
}

/** Click to edit. Ctrl/⌘+B and Ctrl/⌘+I wrap the selection in ** or *. */
export function EditableText({
  value,
  onChange,
  editable = true,
  className,
  placeholder = "Click to type",
  single = false,
  onEnter,
  onBackspaceEmpty,
  autoFocus = false,
}: {
  value: string;
  onChange: (v: string) => void;
  editable?: boolean;
  className?: string;
  placeholder?: string;
  single?: boolean;
  onEnter?: () => void;
  onBackspaceEmpty?: () => void;
  autoFocus?: boolean;
}) {
  const [editing, setEditing] = useState(autoFocus);
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [value, editing]);

  if (!editable) return <div className={cx(className, "whitespace-pre-wrap")}>{value ? <Inline text={value} /> : null}</div>;

  if (editing)
    return (
      <textarea
        ref={ref}
        autoFocus
        rows={1}
        value={value}
        placeholder={placeholder}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onChange(single ? e.target.value.replace(/\n/g, " ") : e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
          e.stopPropagation();
          if ((e.ctrlKey || e.metaKey) && (e.key === "b" || e.key === "i")) {
            e.preventDefault();
            wrapSelection(e.currentTarget, e.key === "b" ? "**" : "*", onChange);
          } else if (e.key === "Escape") {
            e.currentTarget.blur();
          } else if (e.key === "Enter" && !e.shiftKey && (single || onEnter)) {
            e.preventDefault();
            e.currentTarget.blur();
            onEnter?.();
          } else if (e.key === "Backspace" && !value && onBackspaceEmpty) {
            e.preventDefault();
            onBackspaceEmpty();
          }
        }}
        className={cx(
          className,
          "block w-full resize-none overflow-hidden rounded-[2px] bg-white/70 outline outline-1 outline-signal/60 placeholder:text-mute/50",
        )}
      />
    );

  return (
    <div
      role="textbox"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      onFocus={() => setEditing(true)}
      className={cx(className, "cursor-text whitespace-pre-wrap rounded-[2px] hover:outline hover:outline-1 hover:outline-signal/30")}
    >
      {value ? <Inline text={value} /> : <span className="opacity-40">{placeholder}</span>}
    </div>
  );
}

/** Short lines (bullets): Enter adds a line after, Backspace on an empty line removes it. */
export function EditableList({
  items,
  onChange,
  editable,
  className,
  marker,
  itemClass,
}: {
  items: string[];
  onChange: (v: string[]) => void;
  editable: boolean;
  className?: string;
  marker: (i: number) => ReactNode;
  itemClass?: string;
}) {
  const [focus, setFocus] = useState<number | null>(null);
  return (
    <ul className={className}>
      {items.map((it, i) => (
        <li key={i} className="flex items-baseline gap-[0.6em]">
          <span className="shrink-0">{marker(i)}</span>
          <EditableText
            key={`${i}-${focus === i}`}
            value={it}
            editable={editable}
            single
            autoFocus={focus === i}
            className={cx("min-w-0 flex-1", itemClass)}
            onChange={(v) => onChange(items.map((x, j) => (j === i ? v : x)))}
            onEnter={() => {
              onChange([...items.slice(0, i + 1), "", ...items.slice(i + 1)]);
              setFocus(i + 1);
            }}
            onBackspaceEmpty={() => {
              onChange(items.filter((_, j) => j !== i));
              setFocus(i > 0 ? i - 1 : null);
            }}
          />
        </li>
      ))}
      {editable && (
        <li>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onChange([...items, ""]);
              setFocus(items.length);
            }}
            className="text-[0.7em] text-mute opacity-60 hover:text-signal hover:opacity-100"
          >
            + add line
          </button>
        </li>
      )}
    </ul>
  );
}

// ── Charts ──────────────────────────────────────────────────────────────────

export const SERIES_COLORS = ["#ce401b", "#2e6650", "#a87111", "#48433d", "#788ca0", "#b49678"];

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v) ?? v;
}

const fmtTick = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(+v.toFixed(2)));

export function MiniChart({ chart }: { chart: ChartData }) {
  const W = 600,
    H = 300,
    L = 52,
    R = 12,
    T = chart.unit ? 34 : 18,
    B = 46;
  const ink = "#48433d",
    grid = "#d8cfc1";
  const n = chart.labels.length;
  if (!n) return <div className="grid h-full place-items-center text-[0.8em] text-mute">Add data to draw the chart</div>;

  if (chart.type === "pie") {
    const vals = (chart.series[0]?.values ?? []).map((v) => Math.max(0, v ?? 0));
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    const cx0 = 160,
      cy0 = 150,
      r = 125;
    let acc = 0;
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full">
        {vals.map((v, i) => {
          const a0 = (acc / total) * 2 * Math.PI - Math.PI / 2;
          acc += v;
          const a1 = (acc / total) * 2 * Math.PI - Math.PI / 2;
          const d =
            v >= total
              ? `M ${cx0} ${cy0 - r} A ${r} ${r} 0 1 1 ${cx0 - 0.01} ${cy0 - r} Z`
              : `M ${cx0} ${cy0} L ${cx0 + r * Math.cos(a0)} ${cy0 + r * Math.sin(a0)} A ${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${cx0 + r * Math.cos(a1)} ${cy0 + r * Math.sin(a1)} Z`;
          return v > 0 ? <path key={i} d={d} fill={SERIES_COLORS[i % SERIES_COLORS.length]} stroke="#fff" strokeWidth={2} /> : null;
        })}
        {chart.labels.map((l, i) => (
          <g key={i} transform={`translate(320 ${44 + i * 26})`}>
            <rect width={12} height={12} y={-10} fill={SERIES_COLORS[i % SERIES_COLORS.length]} />
            <text x={20} fontSize={14} fill={ink}>
              {l} · {Math.round(((vals[i] ?? 0) / total) * 100)}%
            </text>
          </g>
        ))}
      </svg>
    );
  }

  const all = chart.series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const max = niceMax(Math.max(0, ...all));
  const min = Math.min(0, ...all);
  const y = (v: number) => T + (H - T - B) * (1 - (v - min) / (max - min || 1));
  const band = (W - L - R) / n;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => min + (max - min) * f);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke={grid} strokeWidth={1} />
          <text x={L - 6} y={y(t) + 4} fontSize={11} textAnchor="end" fill={ink}>
            {fmtTick(t)}
          </text>
        </g>
      ))}
      {chart.labels.map((l, i) => (
        <text key={i} x={L + band * (i + 0.5)} y={H - B + 18} fontSize={n > 8 ? 9 : 11} textAnchor="middle" fill={ink}>
          {l.length > 18 ? `${l.slice(0, 17)}…` : l}
        </text>
      ))}
      {chart.type === "bar"
        ? chart.series.map((s, k) => {
            const w = (band * 0.7) / chart.series.length;
            return s.values.map((v, i) =>
              v == null ? null : (
                <rect
                  key={`${k}-${i}`}
                  x={L + band * i + band * 0.15 + k * w}
                  y={Math.min(y(v), y(0))}
                  width={Math.max(1, w - 2)}
                  height={Math.abs(y(0) - y(v))}
                  fill={SERIES_COLORS[k % SERIES_COLORS.length]}
                />
              ),
            );
          })
        : chart.series.map((s, k) => (
            <g key={k}>
              <polyline
                fill="none"
                stroke={SERIES_COLORS[k % SERIES_COLORS.length]}
                strokeWidth={3}
                points={s.values
                  .map((v, i) => (v == null ? null : `${L + band * (i + 0.5)},${y(v)}`))
                  .filter(Boolean)
                  .join(" ")}
              />
              {s.values.map((v, i) =>
                v == null ? null : (
                  <circle key={i} cx={L + band * (i + 0.5)} cy={y(v)} r={4} fill={SERIES_COLORS[k % SERIES_COLORS.length]} />
                ),
              )}
            </g>
          ))}
      {chart.series.length > 1 &&
        chart.series.map((s, k) => (
          <g key={k} transform={`translate(${L + k * 130} ${H - 6})`}>
            <rect width={10} height={10} y={-9} fill={SERIES_COLORS[k % SERIES_COLORS.length]} />
            <text x={15} fontSize={11} fill={ink}>
              {s.name || `Series ${k + 1}`}
            </text>
          </g>
        ))}
      {chart.unit && (
        <text x={4} y={14} fontSize={11} fill={ink}>
          {chart.unit}
        </text>
      )}
    </svg>
  );
}

/** Spreadsheet-style editor for a chart's labels and values. */
export function ChartEditor({ chart, onChange }: { chart: ChartData; onChange: (c: ChartData) => void }) {
  const cell = "w-full min-w-0 border border-rule bg-white px-1.5 py-1 font-mono text-[11px] focus:border-ink focus:outline-none";
  const setVal = (k: number, i: number, raw: string) => {
    const v = raw.trim() === "" ? null : Number(raw.replace(/,/g, ""));
    if (v !== null && !Number.isFinite(v)) return;
    onChange({ ...chart, series: chart.series.map((s, j) => (j === k ? { ...s, values: s.values.map((x, m) => (m === i ? v : x)) } : s)) });
  };
  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        {(["bar", "line", "pie"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onChange({ ...chart, type: t, series: t === "pie" ? chart.series.slice(0, 1) : chart.series })}
            className={cx(
              "flex-1 border px-2 py-1 text-[11.5px] capitalize",
              chart.type === t ? "border-ink bg-ink text-paper" : "border-rule hover:border-ink",
            )}
          >
            {t}
          </button>
        ))}
      </div>
      <input
        value={chart.unit}
        onChange={(e) => onChange({ ...chart, unit: e.target.value })}
        placeholder="Unit (e.g. Rp thousand, %)"
        className={cell}
      />
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="p-0.5 text-left text-[10px] font-normal text-mute">Label</th>
              {chart.series.map((s, k) => (
                <th key={k} className="p-0.5">
                  <div className="flex items-center gap-0.5">
                    <input
                      value={s.name}
                      placeholder={`Series ${k + 1}`}
                      onChange={(e) =>
                        onChange({ ...chart, series: chart.series.map((x, j) => (j === k ? { ...x, name: e.target.value } : x)) })
                      }
                      className={cx(cell, "font-sans font-medium")}
                    />
                    {chart.series.length > 1 && (
                      <button
                        type="button"
                        title="Remove series"
                        onClick={() => onChange({ ...chart, series: chart.series.filter((_, j) => j !== k) })}
                        className="text-mute hover:text-signal"
                      >
                        ×
                      </button>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {chart.labels.map((l, i) => (
              <tr key={i}>
                <td className="p-0.5">
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      title="Remove row"
                      onClick={() =>
                        onChange({
                          ...chart,
                          labels: chart.labels.filter((_, m) => m !== i),
                          series: chart.series.map((s) => ({ ...s, values: s.values.filter((_, m) => m !== i) })),
                        })
                      }
                      className="text-mute hover:text-signal"
                    >
                      ×
                    </button>
                    <input
                      value={l}
                      onChange={(e) => onChange({ ...chart, labels: chart.labels.map((x, m) => (m === i ? e.target.value : x)) })}
                      className={cx(cell, "font-sans")}
                    />
                  </div>
                </td>
                {chart.series.map((s, k) => (
                  <td key={k} className="p-0.5">
                    <input
                      key={`${k}-${i}-${s.values[i]}`}
                      defaultValue={s.values[i] ?? ""}
                      onBlur={(e) => setVal(k, i, e.target.value)}
                      inputMode="decimal"
                      className={cx(cell, "text-right")}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-3 text-[11px]">
        <button
          type="button"
          onClick={() =>
            onChange({
              ...chart,
              labels: [...chart.labels, `Item ${chart.labels.length + 1}`],
              series: chart.series.map((s) => ({ ...s, values: [...s.values, null] })),
            })
          }
          className="text-graphite hover:text-signal"
        >
          + Row
        </button>
        {chart.type !== "pie" && chart.series.length < 6 && (
          <button
            type="button"
            onClick={() => onChange({ ...chart, series: [...chart.series, { name: "", values: chart.labels.map(() => null) }] })}
            className="text-graphite hover:text-signal"
          >
            + Series
          </button>
        )}
      </div>
    </div>
  );
}

// ── Tables ──────────────────────────────────────────────────────────────────

const isNum = (s: string) => /^[-+~]?(Rp|\$|€|£)?\s?[\d.,]+\s?(%|[kKmMbB])?$/.test(s.replace(/\*/g, "").trim());

export function TableBlock({
  table,
  onChange,
  editable,
  className,
  dense = false,
}: {
  table: TableData;
  onChange: (t: TableData) => void;
  editable: boolean;
  className?: string;
  dense?: boolean;
}) {
  const pad = dense ? "px-[0.5em] py-[0.3em]" : "px-[0.7em] py-[0.45em]";
  // Right-align a column only when every filled cell in it is a number.
  const numCol = table.columns.map((_, j) => {
    const vals = table.rows.map((r) => (r[j] ?? "").trim()).filter(Boolean);
    return j > 0 && vals.length > 0 && vals.every(isNum);
  });
  const setCell = (i: number, j: number, v: string) =>
    onChange({ ...table, rows: table.rows.map((row, m) => (m === i ? table.columns.map((_, k) => (k === j ? v : (row[k] ?? ""))) : row)) });
  return (
    <div className={className}>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b-2 border-ink">
            {table.columns.map((c, j) => (
              <th key={j} className={cx(pad, "text-left align-bottom font-semibold")}>
                <div className="flex items-start gap-1">
                  <EditableText
                    value={c}
                    single
                    editable={editable}
                    className="min-w-0 flex-1"
                    onChange={(v) => onChange({ ...table, columns: table.columns.map((x, m) => (m === j ? v : x)) })}
                  />
                  {editable && table.columns.length > 1 && (
                    <button
                      type="button"
                      title="Delete column"
                      onClick={() =>
                        onChange({
                          columns: table.columns.filter((_, m) => m !== j),
                          rows: table.rows.map((r) => r.filter((_, m) => m !== j)),
                        })
                      }
                      className="text-[0.8em] font-normal text-mute opacity-50 hover:text-signal hover:opacity-100"
                    >
                      ×
                    </button>
                  )}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={i} className="group/row border-b border-rule">
              {table.columns.map((_, j) => (
                <td key={j} className={cx(pad, "align-top", numCol[j] && "text-right")}>
                  <div className="flex items-start gap-1">
                    <EditableText
                      value={r[j] ?? ""}
                      single
                      editable={editable}
                      placeholder=""
                      className="min-w-[2em] flex-1"
                      onChange={(v) => setCell(i, j, v)}
                    />
                    {editable && j === table.columns.length - 1 && (
                      <button
                        type="button"
                        title="Delete row"
                        onClick={() => onChange({ ...table, rows: table.rows.filter((_, m) => m !== i) })}
                        className="text-[0.8em] text-mute opacity-0 hover:text-signal group-hover/row:opacity-60"
                      >
                        ×
                      </button>
                    )}
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {editable && (
        <div className="mt-[0.4em] flex gap-3 text-[0.75em]">
          <button
            type="button"
            onClick={() => onChange({ ...table, rows: [...table.rows, table.columns.map(() => "")] })}
            className="text-mute hover:text-signal"
          >
            + row
          </button>
          {table.columns.length < 8 && (
            <button
              type="button"
              onClick={() =>
                onChange({ columns: [...table.columns, `Column ${table.columns.length + 1}`], rows: table.rows.map((r) => [...r, ""]) })
              }
              className="text-mute hover:text-signal"
            >
              + column
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Shown when the source (e.g. a Data chat) has new content since this version was built. */
export function StaleBanner({ show, busy, onUpdate }: { show?: boolean; busy: boolean; onUpdate: () => void }) {
  if (!show) return null;
  return (
    <div className="flex items-center gap-3 border-b border-moss/40 bg-moss/5 px-4 py-1.5 text-[12px] text-graphite">
      <span className="flex-1">The chat has new answers since this was made. Updating keeps the current version in History.</span>
      <button onClick={onUpdate} disabled={busy} className="font-medium text-moss underline-offset-2 hover:underline disabled:opacity-40">
        Update from chat
      </button>
    </div>
  );
}

// ── Top bar pieces ──────────────────────────────────────────────────────────

export function SaveBadge({ state, busy }: { state: SaveState; busy: string }) {
  const text = busy || { loading: "Loading…", saved: "All changes saved", dirty: "Editing…", saving: "Saving…", error: "Not saved" }[state];
  return (
    <span
      className={cx("flex items-center gap-1.5 whitespace-nowrap text-[11.5px]", state === "error" && !busy ? "text-signal" : "text-mute")}
    >
      <span
        className={cx(
          "h-1.5 w-1.5 rounded-full",
          busy || state === "saving" ? "blink bg-signal" : state === "error" ? "bg-signal" : state === "saved" ? "bg-moss" : "bg-ochre",
        )}
      />
      {text}
    </span>
  );
}

export function HistoryMenu({
  load,
  onRestore,
  onRebuild,
}: {
  load: () => Promise<Version[]>;
  onRestore: (v: number) => void;
  onRebuild: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Version[] | null>(null);
  useEffect(() => {
    if (!open) return;
    setList(null);
    load()
      .then(setList)
      .catch(() => setList([]));
  }, [open, load]);
  return (
    <div className="relative">
      <Button size="sm" tone="quiet" onClick={() => setOpen((o) => !o)}>
        History
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-9 z-20 w-[320px] border border-ink bg-white p-2 shadow-lg">
            <div className="label mb-1.5 px-1">Versions</div>
            {!list ? (
              <p className="px-1 py-2 text-[12px] text-mute">Loading…</p>
            ) : (
              <ul className="max-h-[300px] overflow-y-auto">
                {list.map((v) => (
                  <li key={v.version} className="flex items-center gap-2 border-t border-rule px-1 py-1.5 text-[12px]">
                    <span className="w-7 font-mono text-[10.5px] text-mute">v{v.version}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ink" title={v.note}>
                        {v.note || "Edited"}
                      </span>
                      <span className="block text-[10.5px] text-mute">{new Date(v.updated_at).toLocaleString()}</span>
                    </span>
                    {v.current ? (
                      <span className="text-[10.5px] text-moss">current</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setOpen(false);
                          onRestore(v.version);
                        }}
                        className="text-[11.5px] text-signal hover:underline"
                      >
                        Restore
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                if (window.confirm("Start over from the agent's original report? Your current version stays in History.")) onRebuild();
              }}
              className="mt-1 w-full border-t border-rule px-1 pt-2 text-left text-[11.5px] text-graphite hover:text-signal"
            >
              Start over from the agent&apos;s report…
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** "Ask AI": one instruction, applied to the selected slide/block or to everything. */
export function AiBox({
  noun,
  hasTarget,
  suggestions,
  busy,
  onRun,
}: {
  noun: string;
  hasTarget: boolean;
  suggestions: string[];
  busy: boolean;
  onRun: (instruction: string, whole: boolean) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [whole, setWhole] = useState(!hasTarget);
  useEffect(() => setWhole(!hasTarget), [hasTarget]);
  const go = async () => {
    if (text.trim().length < 3 || busy) return;
    if (await onRun(text.trim(), whole)) setText("");
  };
  return (
    <div className="space-y-2">
      <div className="label">Ask AI</div>
      <div className="flex gap-1 text-[11.5px]">
        <button
          type="button"
          disabled={!hasTarget}
          onClick={() => setWhole(false)}
          className={cx(
            "flex-1 border px-2 py-1 disabled:opacity-40",
            !whole ? "border-ink bg-ink text-paper" : "border-rule hover:border-ink",
          )}
        >
          This {noun}
        </button>
        <button
          type="button"
          onClick={() => setWhole(true)}
          className={cx("flex-1 border px-2 py-1", whole ? "border-ink bg-ink text-paper" : "border-rule hover:border-ink")}
        >
          Everything
        </button>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void go();
        }}
        rows={3}
        placeholder={whole ? "e.g. Translate everything to Bahasa Indonesia" : `e.g. Make this ${noun} shorter`}
        className="w-full resize-none border border-rule bg-white px-2.5 py-2 text-[12.5px] focus:border-ink focus:outline-none"
      />
      <div className="flex flex-wrap gap-1">
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setText(s)}
            className="border border-rule px-1.5 py-0.5 text-[10.5px] text-graphite hover:border-ink hover:text-ink"
          >
            {s}
          </button>
        ))}
      </div>
      <Button size="sm" tone="ink" className="w-full" disabled={busy || text.trim().length < 3} onClick={go}>
        {busy ? "Claude is editing…" : "Apply · 3 credits"}
      </Button>
      <p className="text-[10.5px] leading-snug text-mute">Every AI edit is saved as a version, so History can undo it.</p>
    </div>
  );
}

// ── Images (charts from the source) ─────────────────────────────────────────

export function ImagePicker({ assets, value, onPick }: { assets: Asset[]; value: string; onPick: (a: Asset) => void }) {
  if (!assets.length) return <p className="text-[11.5px] text-mute">This report has no charts to place.</p>;
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {assets.map((a) => (
        <button
          key={a.url}
          type="button"
          onClick={() => onPick(a)}
          title={a.title}
          className={cx("border-2 bg-white p-0.5 text-left", a.url === value ? "border-signal" : "border-transparent hover:border-rule")}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={a.url} alt={a.title} className="aspect-[4/3] w-full object-contain" />
          <span className="mt-0.5 block truncate px-0.5 text-[10px] text-graphite">{a.title}</span>
        </button>
      ))}
    </div>
  );
}
