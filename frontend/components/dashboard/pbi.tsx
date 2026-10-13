"use client";

// Power BI–style visuals drawn as SVG (no chart library): default Power BI palette,
// Segoe UI, white tiles on a grey canvas, compact K/M number formats, "(Blank)" for
// missing values, hover tooltips, and dimming of unselected data points when a
// cross-filter selection is active.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ValueFormat } from "@/lib/types";

export const PBI = {
  palette: ["#118DFF", "#12239E", "#E66C37", "#6B007B", "#E044A7", "#744EC2", "#D9B300", "#D64550"],
  canvas: "#F3F2F1",
  tile: "#FFFFFF",
  ink: "#252423",
  sub: "#605E5C",
  faint: "#A19F9D",
  grid: "#EDEBE9",
  border: "#E1DFDD",
  font: '"Segoe UI", "Segoe UI Web (West European)", -apple-system, BlinkMacSystemFont, Roboto, "Helvetica Neue", sans-serif',
};

// ── Formatting ────────────────────────────────────────────────────────────────

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function compact(n: number, digits = 2): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(digits)}bn`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(digits)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(digits)}K`;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : 2);
}

// Currency of the dashboard being shown (from its spec). No symbol when unknown —
// never assume dollars.
const SYMBOLS: Record<string, string> = {
  IDR: "Rp ", USD: "$", EUR: "€", GBP: "£", JPY: "¥", SGD: "S$", MYR: "RM ", INR: "₹", AUD: "A$",
};
let currencyPrefix = "";
export function setCurrency(code?: string) {
  currencyPrefix = code ? (SYMBOLS[code] ?? `${code} `) : "";
}

export function fmt(v: unknown, f: ValueFormat = "number", precise = false): string {
  const n = num(v);
  if (n === null) return typeof v === "string" && v ? v : "(Blank)";
  if (f === "percent") return `${n.toFixed(precise ? 2 : 1)}%`;
  if (f === "currency") return `${currencyPrefix}${compact(n)}`;
  if (f === "decimal") return precise ? n.toFixed(2) : compact(n);
  return precise && Math.abs(n) < 1e4 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : compact(n);
}

function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const ticks: number[] = [];
  for (let t = 0; t <= max + step * 0.001; t += step) ticks.push(+t.toFixed(10));
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s);

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

// ── Shared chrome ─────────────────────────────────────────────────────────────

interface Tip {
  x: number;
  y: number;
  title: string;
  rows: { label: string; value: string; color?: string }[];
}

function Tooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div
      className="pointer-events-none absolute z-20 min-w-[140px] rounded-[2px] bg-white px-3 py-2 text-[12px] shadow-[0_2px_8px_rgba(0,0,0,0.18)]"
      style={{ left: tip.x + 12, top: tip.y + 12, color: PBI.ink }}
    >
      <div className="mb-1 font-semibold">{tip.title}</div>
      {tip.rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5" style={{ color: PBI.sub }}>
            {r.color && <span className="inline-block h-2 w-2 rounded-full" style={{ background: r.color }} />}
            {r.label}
          </span>
          <span className="font-semibold">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

export function Tile({ title, subtitle, children, style }: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <section
      className="relative flex min-w-0 flex-col rounded-[4px] bg-white p-3 shadow-[0_1px_3px_rgba(0,0,0,0.08)]"
      style={{ border: `1px solid ${PBI.border}`, ...style }}
    >
      {title && (
        <header className="mb-1">
          <h3 className="truncate text-[14px] font-semibold" style={{ color: PBI.ink }}>{title}</h3>
          {subtitle && <p className="truncate text-[11px]" style={{ color: PBI.sub }}>{subtitle}</p>}
        </header>
      )}
      {children}
    </section>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  if (items.length < 2) return null;
  return (
    <div className="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px]" style={{ color: PBI.sub }}>
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

// ── KPI card ──────────────────────────────────────────────────────────────────

export function KpiCard({ label, value, format, note, error }: {
  label: string;
  value: unknown;
  format: ValueFormat;
  note?: string;
  error?: string;
}) {
  return (
    <Tile style={{ minHeight: 112, justifyContent: "center" }}>
      <div title={error || note} className="flex flex-col items-center justify-center text-center">
        <div className="text-[32px] font-semibold leading-tight tabular-nums" style={{ color: PBI.ink }}>
          {error ? "—" : fmt(value, format, format === "percent")}
        </div>
        <div className="mt-1 text-[13px]" style={{ color: PBI.sub }}>{label}</div>
      </div>
    </Tile>
  );
}

// ── Bar / column chart ────────────────────────────────────────────────────────

interface SeriesProps {
  rows: Record<string, unknown>[];
  x: string;
  y: string[];
  format: ValueFormat;
  height?: number;
  selected?: Set<string>;
  onSelect?: (label: string) => void;
}

export function BarChart({ rows, x, y, format, horizontal = false, height = 260, selected, onSelect }:
  SeriesProps & { horizontal?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const labels = rows.map((r) => String(r[x] ?? "(Blank)"));
  const series = y.map((key, i) => ({ key, color: PBI.palette[i % PBI.palette.length], values: rows.map((r) => num(r[key]) ?? 0) }));
  const max = Math.max(0, ...series.flatMap((s) => s.values));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const anySel = !!selected && selected.size > 0;
  const showLabels = labels.length * series.length <= 16;

  const longest = Math.max(...labels.map((l) => l.length), 1);
  const m = horizontal
    ? { l: Math.min(150, 12 + longest * 6.4), r: 44, t: 6, b: 24 }
    : { l: 46, r: 8, t: showLabels ? 18 : 8, b: 30 };
  const iw = Math.max(10, width - m.l - m.r);
  const ih = Math.max(10, height - m.t - m.b);
  const band = (horizontal ? ih : iw) / Math.max(1, labels.length);
  const barSize = Math.max(2, (band * 0.72) / series.length);
  const scale = (v: number) => (v / top) * (horizontal ? iw : ih);

  const hover = (e: React.MouseEvent, i: number) => {
    const box = (ref.current as HTMLDivElement).getBoundingClientRect();
    setTip({ x: e.clientX - box.left, y: e.clientY - box.top, title: labels[i],
      rows: series.map((s) => ({ label: s.key, value: fmt(s.values[i], format, true), color: s.color })) });
  };

  return (
    <div className="relative">
      <Legend items={series.map((s) => ({ label: s.key, color: s.color }))} />
      <div ref={ref} className="relative w-full" style={{ height }} onMouseLeave={() => setTip(null)}>
        {width > 0 && (
          <svg width={width} height={height} style={{ fontFamily: PBI.font }}>
            {ticks.map((t) => {
              const p = scale(t);
              return horizontal ? (
                <g key={t}>
                  <line x1={m.l + p} x2={m.l + p} y1={m.t} y2={m.t + ih} stroke={PBI.grid} />
                  <text x={m.l + p} y={height - 6} fontSize={11} fill={PBI.sub} textAnchor="middle">{fmt(t, format)}</text>
                </g>
              ) : (
                <g key={t}>
                  <line x1={m.l} x2={m.l + iw} y1={m.t + ih - p} y2={m.t + ih - p} stroke={PBI.grid} />
                  <text x={m.l - 6} y={m.t + ih - p + 4} fontSize={11} fill={PBI.sub} textAnchor="end">{fmt(t, format)}</text>
                </g>
              );
            })}
            {labels.map((label, i) => {
              const dim = anySel && !selected!.has(label);
              const base = i * band + (band - barSize * series.length) / 2;
              return (
                <g key={label + i} style={{ cursor: onSelect ? "pointer" : "default" }}
                  onMouseMove={(e) => hover(e, i)} onClick={() => onSelect?.(label)}>
                  <rect x={horizontal ? m.l : m.l + i * band} y={horizontal ? m.t + i * band : m.t}
                    width={horizontal ? iw : band} height={horizontal ? band : ih} fill="transparent" />
                  {series.map((s, si) => {
                    const v = s.values[i];
                    const len = scale(Math.max(0, v));
                    const off = base + si * barSize;
                    return (
                      <g key={s.key} opacity={dim ? 0.35 : 1}>
                        {horizontal ? (
                          <rect x={m.l} y={m.t + off} width={len} height={barSize} fill={s.color} />
                        ) : (
                          <rect x={m.l + off} y={m.t + ih - len} width={barSize} height={len} fill={s.color} />
                        )}
                        {showLabels && (horizontal ? (
                          <text x={m.l + len + 4} y={m.t + off + barSize / 2 + 4} fontSize={11} fill={PBI.sub}>{fmt(v, format)}</text>
                        ) : (
                          <text x={m.l + off + barSize / 2} y={m.t + ih - len - 4} fontSize={11} fill={PBI.sub} textAnchor="middle">{fmt(v, format)}</text>
                        ))}
                      </g>
                    );
                  })}
                  {horizontal ? (
                    <text x={m.l - 6} y={m.t + i * band + band / 2 + 4} fontSize={11} fill={PBI.sub} textAnchor="end">
                      {clip(label, Math.floor((m.l - 10) / 6.4))}
                    </text>
                  ) : (
                    <text x={m.l + i * band + band / 2} y={height - 10} fontSize={11} fill={PBI.sub} textAnchor="middle">
                      {clip(label, Math.max(3, Math.floor(band / 6.6)))}
                    </text>
                  )}
                </g>
              );
            })}
            <line x1={m.l} x2={horizontal ? m.l : m.l + iw} y1={horizontal ? m.t : m.t + ih} y2={m.t + ih} stroke={PBI.border} />
          </svg>
        )}
        <Tooltip tip={tip} />
      </div>
    </div>
  );
}

// ── Line chart ────────────────────────────────────────────────────────────────

export function LineChart({ rows, x, y, format, height = 260 }: SeriesProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const labels = rows.map((r) => String(r[x] ?? "(Blank)"));
  const series = y.map((key, i) => ({ key, color: PBI.palette[i % PBI.palette.length], values: rows.map((r) => num(r[key])) }));
  const vals = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const ticks = niceTicks(Math.max(0, ...vals));
  const top = ticks[ticks.length - 1] || 1;
  const m = { l: 46, r: 12, t: 10, b: 30 };
  const iw = Math.max(10, width - m.l - m.r);
  const ih = Math.max(10, height - m.t - m.b);
  const px = (i: number) => m.l + (labels.length < 2 ? iw / 2 : (i / (labels.length - 1)) * iw);
  const py = (v: number) => m.t + ih - (v / top) * ih;
  const every = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor(iw / 70))));

  const move = (e: React.MouseEvent) => {
    const box = (ref.current as HTMLDivElement).getBoundingClientRect();
    const rel = e.clientX - box.left - m.l;
    const i = Math.max(0, Math.min(labels.length - 1, Math.round((rel / iw) * (labels.length - 1))));
    setHoverIdx(i);
    setTip({ x: e.clientX - box.left, y: e.clientY - box.top, title: labels[i],
      rows: series.map((s) => ({ label: s.key, value: fmt(s.values[i], format, true), color: s.color })) });
  };

  return (
    <div className="relative">
      <Legend items={series.map((s) => ({ label: s.key, color: s.color }))} />
      <div ref={ref} className="relative w-full" style={{ height }}
        onMouseMove={move} onMouseLeave={() => { setTip(null); setHoverIdx(null); }}>
        {width > 0 && (
          <svg width={width} height={height} style={{ fontFamily: PBI.font }}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={m.l} x2={m.l + iw} y1={py(t)} y2={py(t)} stroke={PBI.grid} />
                <text x={m.l - 6} y={py(t) + 4} fontSize={11} fill={PBI.sub} textAnchor="end">{fmt(t, format)}</text>
              </g>
            ))}
            {labels.map((l, i) => i % every === 0 && (
              <text key={l + i} x={px(i)} y={height - 10} fontSize={11} fill={PBI.sub} textAnchor="middle">{clip(l, 12)}</text>
            ))}
            {hoverIdx !== null && (
              <line x1={px(hoverIdx)} x2={px(hoverIdx)} y1={m.t} y2={m.t + ih} stroke={PBI.faint} strokeDasharray="3 3" />
            )}
            {series.map((s) => {
              const pts = s.values.map((v, i) => (v === null ? null : `${px(i)},${py(v)}`)).filter(Boolean).join(" ");
              return (
                <g key={s.key}>
                  <polyline points={pts} fill="none" stroke={s.color} strokeWidth={2} />
                  {s.values.map((v, i) => v !== null && (labels.length <= 24 || i === hoverIdx) && (
                    <circle key={i} cx={px(i)} cy={py(v)} r={i === hoverIdx ? 4.5 : 3} fill={s.color} stroke="#fff" strokeWidth={1.5} />
                  ))}
                </g>
              );
            })}
          </svg>
        )}
        <Tooltip tip={tip} />
      </div>
    </div>
  );
}

// ── Donut chart ───────────────────────────────────────────────────────────────

export function DonutChart({ rows, x, y, format, height = 260, selected, onSelect }: SeriesProps) {
  const [tip, setTip] = useState<Tip | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const items = rows.map((r, i) => ({
    label: String(r[x] ?? "(Blank)"),
    value: Math.max(0, num(r[y[0]]) ?? 0),
    color: PBI.palette[i % PBI.palette.length],
  }));
  const total = items.reduce((a, b) => a + b.value, 0) || 1;
  const size = Math.min(height - 10, 220);
  const R = size / 2;
  const r = R * 0.58;
  const anySel = !!selected && selected.size > 0;
  let angle = -Math.PI / 2;

  const arc = (a0: number, a1: number) => {
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad: number, ang: number) => `${R + rad * Math.cos(ang)} ${R + rad * Math.sin(ang)}`;
    return `M ${p(R, a0)} A ${R} ${R} 0 ${large} 1 ${p(R, a1)} L ${p(r, a1)} A ${r} ${r} 0 ${large} 0 ${p(r, a0)} Z`;
  };

  return (
    <div ref={boxRef} className="relative flex items-center gap-5" style={{ minHeight: height }} onMouseLeave={() => setTip(null)}>
      <svg width={size} height={size} className="shrink-0">
        {items.map((it) => {
          const a0 = angle;
          const a1 = angle + (it.value / total) * Math.PI * 2 - 0.0001;
          angle = a1 + 0.0001;
          const dim = anySel && !selected!.has(it.label);
          return (
            <path key={it.label} d={arc(a0, a1)} fill={it.color} stroke="#fff" strokeWidth={1.5} opacity={dim ? 0.35 : 1}
              style={{ cursor: onSelect ? "pointer" : "default" }} onClick={() => onSelect?.(it.label)}
              onMouseMove={(e) => {
                const box = boxRef.current!.getBoundingClientRect();
                setTip({ x: e.clientX - box.left, y: e.clientY - box.top, title: it.label, rows: [
                  { label: y[0], value: fmt(it.value, format, true), color: it.color },
                  { label: "Share", value: `${((it.value / total) * 100).toFixed(1)}%` }] });
              }} />
          );
        })}
      </svg>
      <ul className="min-w-0 space-y-1.5 text-[12px]">
        {items.map((it) => (
          <li key={it.label} className="flex items-center gap-2"
            style={{ color: PBI.sub, opacity: anySel && !selected!.has(it.label) ? 0.45 : 1 }}>
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: it.color }} />
            <span className="truncate">{it.label}</span>
            <span className="ml-auto pl-3 font-semibold tabular-nums" style={{ color: PBI.ink }}>
              {((it.value / total) * 100).toFixed(1)}%
            </span>
          </li>
        ))}
      </ul>
      <Tooltip tip={tip} />
    </div>
  );
}

// ── Table ─────────────────────────────────────────────────────────────────────

export function TableVisual({ rows, format, height = 260 }: { rows: Record<string, unknown>[]; format: ValueFormat; height?: number }) {
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const numeric = new Set(cols.filter((c) => rows.every((r) => r[c] === null || num(r[c]) !== null)));
  return (
    <div className="overflow-auto" style={{ maxHeight: height }}>
      <table className="w-full border-collapse text-[12px]" style={{ color: PBI.ink }}>
        <thead className="sticky top-0 bg-white">
          <tr>
            {cols.map((c) => (
              <th key={c} className={`border-b-2 px-2 py-1.5 font-semibold ${numeric.has(c) ? "text-right" : "text-left"}`}
                style={{ borderColor: PBI.ink }}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ background: i % 2 ? PBI.canvas : "#fff" }}>
              {cols.map((c) => (
                <td key={c} className={`px-2 py-1.5 ${numeric.has(c) ? "text-right tabular-nums" : ""}`}>
                  {numeric.has(c) ? fmt(r[c], format, true) : String(r[c] ?? "(Blank)")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Slicer (dropdown, multi-select) ───────────────────────────────────────────

export function Slicer({ label, options, value, onChange }: {
  label: string;
  options: { value: string; count: number }[];
  value: string[];
  onChange: (next: string[]) => void;
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
  const shown = value.length === 0 ? "All" : value.length === 1 ? value[0] : "Multiple selections";
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);

  return (
    <div ref={ref} className="relative min-w-[170px] flex-1">
      <Tile>
        <div className="text-[12px] font-semibold" style={{ color: PBI.ink }}>{label}</div>
        <button type="button" onClick={() => setOpen((o) => !o)}
          className="mt-1 flex w-full items-center justify-between rounded-[2px] px-2 py-1 text-left text-[12px]"
          style={{ border: `1px solid ${PBI.border}`, color: PBI.ink }}>
          <span className="truncate">{shown}</span>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M1 3l4 4 4-4" stroke={PBI.sub} fill="none" strokeWidth="1.5" /></svg>
        </button>
      </Tile>
      {open && (
        <div className="absolute left-0 right-0 z-30 mt-1 max-h-72 overflow-auto rounded-[2px] bg-white py-1 text-[12px] shadow-[0_4px_12px_rgba(0,0,0,0.18)]"
          style={{ color: PBI.ink }}>
          <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-[#F3F2F1]">
            <input type="checkbox" checked={value.length === 0} onChange={() => onChange([])} className="accent-[#118DFF]" />
            Select all
          </label>
          {options.map((o) => (
            <label key={o.value} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-[#F3F2F1]">
              <input type="checkbox" checked={value.includes(o.value)} onChange={() => toggle(o.value)} className="accent-[#118DFF]" />
              <span className="truncate">{o.value}</span>
              <span className="ml-auto pl-2 tabular-nums" style={{ color: PBI.faint }}>{fmt(o.count)}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
