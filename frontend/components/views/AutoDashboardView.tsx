"use client";

// Auto Dashboard (GoArif-style). Give files, a database, sample data or a mix plus an
// optional goal; Claude explores the data, designs KPIs / charts / filters, repairs failed
// queries and writes the insights (features/auto_dashboard.py). After that, filters,
// cross-filtering, layout edits, undo and exports re-run saved SQL only (no AI, free).
// The chat answers questions about what is on screen or edits the dashboard.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BarChart, DonutChart, KpiCard, LineChart, PBI, Slicer, TableVisual, Tile, setCurrency } from "@/components/dashboard/pbi";
import { ColorMenu, GripIcon, TypeGlyph, useDragSort } from "@/components/dashboard/editing";
import { AppConnectors } from "@/components/AppConnectors";
import { WarehouseConnect } from "@/components/WarehouseConnect";
import { Markdown } from "@/components/Markdown";
import { OpenStudio } from "@/components/studio/OpenStudio";
import { QualityReport, type Quality } from "@/components/views/MetricsView";
import { del, errorText, getJSON, postForm, postJSON } from "@/lib/api";
import type { ImportedFile, ValueFormat } from "@/lib/types";

type Sel = Record<string, string[]>;
type ChartType = "bar" | "horizontal_bar" | "stacked_bar" | "line" | "area" | "pie" | "table";
type Height = "s" | "m" | "l";

interface AdFilter {
  id: string;
  label: string;
  kind: "category" | "date";
  column: string;
  options: { value: string; count: number }[] | string[];
}
interface AdKpi {
  id: string;
  title: string;
  format: ValueFormat;
  note?: string;
  value?: number | null;
  error?: string;
  sql: string;
  source: string;
}
interface AdChart {
  id: string;
  title: string;
  type: ChartType;
  width: "half" | "full";
  format: ValueFormat;
  filter_id: string;
  insight: string;
  x?: string;
  y?: string[];
  rows?: Record<string, unknown>[];
  error?: string;
  sql: string;
  source: string;
  /** Set by hand in the editor: own colours (empty = the dashboard's), height, insight shown. */
  palette?: string[];
  height?: Height;
  show_insight?: boolean;
}
interface AdDash {
  title: string;
  subtitle: string;
  strategy: string;
  currency: string;
  summary: string;
  filters: AdFilter[];
  kpis: AdKpi[];
  charts: AdChart[];
  selections: Sel;
  refreshed_at?: string;
  notes: string[];
  /** The dashboard's chart colours (empty = Power BI default). */
  palette?: string[];
}
interface AdTurn {
  role: "user" | "assistant";
  content: string;
  action?: string;
  chart_id?: string;
  queries?: { source: string; sql: string; ok: boolean; rows: number; error?: string }[];
}
interface AdState {
  id: string;
  status: "building" | "ready" | "failed";
  progress: string;
  error: string;
  goal: string;
  language: string;
  sources: {
    files: string[];
    kit: string | null;
    db: { provider: string; engine: string; database: string; host: string; schema: string } | null;
    imports: string[];
  };
  version: number;
  versions: number;
  history: AdTurn[];
  dashboard: AdDash | null;
  usage: { calls?: number; input_tokens?: number; output_tokens?: number; cache_read_tokens?: number };
  quality?: Quality;
  quality_log?: { at: string; fix: string }[];
}
interface AdSummary {
  id: string;
  title: string;
  status: string;
  updated_at: string;
  tiles: number;
  sources: string[];
}
interface AdJob {
  id: string;
  status: "running" | "completed" | "failed";
  error?: string;
  progress?: string;
  reply?: string;
  action?: string;
  dashboard?: AdDash;
  state?: AdState;
}
interface Kit {
  id: string;
  name: string;
  industry: string;
  tagline: string;
}
interface LayoutPayload {
  kpis: { id: string; title: string }[];
  charts: { id: string; title: string; type: ChartType; width: string; height: Height; palette: string[]; show_insight: boolean }[];
  palette: string[];
  title: string;
  subtitle: string;
}

const STAGES: [string, string][] = [
  ["loading", "Loading your data"],
  ["profiling", "Profiling tables and columns"],
  ["exploring", "Exploring coverage, splits and joins"],
  ["designing", "Designing KPIs, charts and filters"],
  ["querying", "Running queries, repairing, writing insights"],
];
const TYPE_LABEL: Record<ChartType, string> = {
  bar: "Column", horizontal_bar: "Bar", stacked_bar: "Stacked column", line: "Line", area: "Area", pie: "Donut", table: "Table",
};
const HEIGHT_PX: Record<Height, number> = { s: 180, m: 260, l: 380 };
const HEIGHT_LABEL: Record<Height, string> = { s: "Small", m: "Medium", l: "Large" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollJob(id: string): Promise<AdJob> {
  for (;;) {
    const j = await getJSON<AdJob>(`/api/autodash/jobs/${id}`);
    if (j.status !== "running") return j;
    await sleep(1500);
  }
}

function Btn({ children, onClick, active, disabled, title, primary }: {
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  primary?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title}
      className="rounded-[2px] px-2.5 py-1 text-[12px] transition-colors hover:brightness-95 disabled:opacity-40"
      style={primary
        ? { background: PBI.palette[0], color: "#fff", fontWeight: 600 }
        : { color: PBI.ink, background: active ? "#EDEBE9" : undefined }}>
      {children}
    </button>
  );
}

function Notice({ tone = "error", children }: { tone?: "error" | "info"; children: ReactNode }) {
  const s = tone === "error"
    ? { borderColor: "#D64550", color: "#A4262C", background: "#FDE7E9" }
    : { borderColor: PBI.border, color: PBI.sub, background: "#fff" };
  return <div className="mb-3 rounded-[2px] border px-3 py-2 text-[12px]" style={s}>{children}</div>;
}

// ── Create panel ─────────────────────────────────────────────────────────────

function CreatePanel({ onStarted }: { onStarted: (jobId: string, id: string) => void }) {
  const [goal, setGoal] = useState("");
  const [language, setLanguage] = useState("English");
  const [files, setFiles] = useState<File[]>([]);
  const [imports, setImports] = useState<ImportedFile[]>([]);
  const [kits, setKits] = useState<Kit[]>([]);
  const [kit, setKit] = useState("");
  const [dbOpen, setDbOpen] = useState(false);
  const [dbUri, setDbUri] = useState("");
  const [schema, setSchema] = useState("");
  const [dbTest, setDbTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getJSON<Kit[]>("/api/kits").then(setKits).catch(() => setKits([]));
  }, []);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    setFiles((cur) => [...cur, ...Array.from(list)].slice(0, 5));
    setKit("");
  };

  const testDb = async () => {
    setDbTest(null);
    try {
      const r = await postJSON<{ ok: boolean; error?: string; tables?: unknown[]; provider?: string }>(
        "/api/db/test", { uri: dbUri, schema });
      setDbTest(r.ok
        ? { ok: true, text: `Connected${r.provider ? ` (${r.provider})` : ""} · ${(r.tables || []).length} tables` }
        : { ok: false, text: r.error || "Could not connect." });
    } catch (e) {
      setDbTest({ ok: false, text: errorText(e) });
    }
  };

  const hasSource = files.length > 0 || imports.length > 0 || !!kit || !!dbUri.trim();

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      files.forEach((f) => form.append("files", f));
      form.append("goal", goal);
      form.append("language", language);
      form.append("kit", kit);
      form.append("db_uri", dbUri.trim());
      form.append("db_schema", schema.trim());
      form.append("import_ids", imports.map((i) => i.file_id).join(","));
      const r = await postForm<{ job_id: string; dashboard: AdState }>("/api/autodash", form);
      onStarted(r.job_id, r.dashboard.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const box = "rounded-[4px] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.08)]";
  const field = "w-full rounded-[2px] border bg-white px-2 py-1.5 text-[13px] outline-none focus:border-[#118DFF]";

  return (
    <div className="mx-auto max-w-3xl space-y-3 py-6">
      <div>
        <h2 className="text-[22px] font-semibold">Automatic dashboard</h2>
        <p className="mt-1 text-[13px]" style={{ color: PBI.sub }}>
          Give it data and, if you like, a goal. Claude explores the data, picks the KPIs, charts and filters,
          checks every query and writes the insights. Filtering, layout changes and exports afterwards are free.
        </p>
      </div>
      {error && <Notice>{error}</Notice>}

      <section className={box}>
        <label className="text-[12px] font-semibold" htmlFor="ad-goal">Goal <span style={{ color: PBI.faint }}>(optional)</span></label>
        <textarea id="ad-goal" value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} maxLength={2000}
          placeholder="e.g. Sales performance by outlet and channel, and which products drive margin"
          className={`${field} mt-1 resize-y`} style={{ borderColor: PBI.border }} />
        <div className="mt-2 flex items-center gap-2 text-[12px]">
          <span style={{ color: PBI.sub }}>Language</span>
          {["English", "Indonesian"].map((l) => (
            <Btn key={l} active={language === l} onClick={() => setLanguage(l)}>{l === "Indonesian" ? "Bahasa Indonesia" : l}</Btn>
          ))}
        </div>
      </section>

      <section className={box}>
        <div className="mb-2 text-[12px] font-semibold">Data files</div>
        <div
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") input.current?.click(); }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
          onClick={() => input.current?.click()}
          className="cursor-pointer rounded-[2px] border border-dashed px-4 py-5 text-center text-[13px]"
          style={{ borderColor: PBI.border, color: PBI.sub }}>
          Drop CSV, Excel, Parquet or JSON files here, or click to choose (up to 5 files, 30 MB each)
          <input ref={input} type="file" multiple hidden accept=".csv,.tsv,.txt,.xlsx,.xlsm,.xls,.parquet,.json,.feather"
            onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        </div>
        {(files.length > 0 || imports.length > 0) && (
          <ul className="mt-2 space-y-1 text-[12px]">
            {files.map((f, i) => (
              <li key={f.name + i} className="flex items-center justify-between rounded-[2px] px-2 py-1" style={{ background: PBI.canvas }}>
                <span className="truncate">{f.name}</span>
                <button type="button" onClick={() => setFiles((c) => c.filter((_, j) => j !== i))} style={{ color: PBI.sub }}>Remove</button>
              </li>
            ))}
            {imports.map((f) => (
              <li key={f.file_id} className="flex items-center justify-between rounded-[2px] px-2 py-1" style={{ background: PBI.canvas }}>
                <span className="truncate">{f.filename} <span style={{ color: PBI.faint }}>· {f.source}</span></span>
                <button type="button" onClick={() => setImports((c) => c.filter((x) => x.file_id !== f.file_id))} style={{ color: PBI.sub }}>Remove</button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3">
          <AppConnectors tabularOnly onImported={(f) => { setImports((c) => [...c, f]); setKit(""); }} />
        </div>
        {kits.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-[12px]" style={{ color: PBI.sub }}>Or try sample data</div>
            <div className="flex flex-wrap gap-2">
              {kits.map((k) => (
                <button key={k.id} type="button" title={k.tagline}
                  onClick={() => { setKit(kit === k.id ? "" : k.id); setFiles([]); setImports([]); }}
                  className="rounded-[2px] border px-2.5 py-1 text-[12px]"
                  style={{ borderColor: kit === k.id ? PBI.palette[0] : PBI.border, background: kit === k.id ? "#E8F3FF" : "#fff" }}>
                  {k.name} <span style={{ color: PBI.faint }}>· {k.industry}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className={box}>
        <button type="button" onClick={() => setDbOpen((o) => !o)} className="text-[12px] font-semibold">
          {dbOpen ? "▾" : "▸"} Database <span className="font-normal" style={{ color: PBI.faint }}>(optional; can be combined with files)</span>
        </button>
        {dbOpen && (
          <div className="mt-2 space-y-2">
            <input value={dbUri} onChange={(e) => { setDbUri(e.target.value); setDbTest(null); }} type="password" autoComplete="off"
              placeholder="postgresql://user:password@host:5432/database (also MySQL, SQL Server, Snowflake, BigQuery …)"
              className={field} style={{ borderColor: PBI.border }} />
            <WarehouseConnect onUri={(u) => { setDbUri(u); setDbTest(null); }} />
            <div className="flex flex-wrap items-center gap-2">
              <input value={schema} onChange={(e) => setSchema(e.target.value)} placeholder="Schema (optional)"
                className={`${field} max-w-[220px]`} style={{ borderColor: PBI.border }} />
              <Btn onClick={testDb} disabled={!dbUri.trim()}>Test connection</Btn>
              {dbTest && <span className="text-[12px]" style={{ color: dbTest.ok ? "#107C10" : "#A4262C" }}>{dbTest.text}</span>}
            </div>
            <p className="text-[11px]" style={{ color: PBI.faint }}>
              Queries run read-only with a time limit. The connection string stays on the server and is never shown again.
            </p>
          </div>
        )}
      </section>

      <div className="flex items-center justify-end gap-3">
        <span className="text-[12px]" style={{ color: PBI.sub }}>20 credits · refunded if the build fails</span>
        <button type="button" onClick={start} disabled={!hasSource || busy}
          className="rounded-[2px] px-5 py-2 text-[13px] font-semibold text-white disabled:opacity-40" style={{ background: PBI.palette[0] }}>
          {busy ? "Starting…" : "Build dashboard"}
        </button>
      </div>
    </div>
  );
}

// ── Building progress ────────────────────────────────────────────────────────

function Building({ progress }: { progress: string }) {
  const at = Math.max(0, STAGES.findIndex(([k]) => k === progress));
  return (
    <div className="mx-auto mt-16 max-w-md rounded-[4px] bg-white p-6 shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
      <h3 className="text-[16px] font-semibold">Building your dashboard…</h3>
      <p className="mt-1 text-[12px]" style={{ color: PBI.sub }}>Usually 20–60 seconds. You can switch apps meanwhile.</p>
      <ol className="mt-4 space-y-2 text-[13px]">
        {STAGES.map(([k, label], i) => (
          <li key={k} className="flex items-center gap-2" style={{ color: i <= at ? PBI.ink : PBI.faint }}>
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] text-white"
              style={{ background: i < at ? "#107C10" : i === at ? PBI.palette[0] : PBI.border }}>
              {i < at ? "✓" : ""}
            </span>
            {label}
            {i === at && <span className="animate-pulse">…</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ── Visual tile ──────────────────────────────────────────────────────────────

/** The chart itself, drawn the way its type says, in its own colours or the dashboard's. */
function ChartBody({ chart, palette, selected, onSelect }: {
  chart: AdChart;
  palette: string[];
  selected: Set<string>;
  onSelect?: (value: string) => void;
}) {
  const rows = chart.rows || [];
  const x = chart.x || "";
  const y = chart.y || [];
  const pal = chart.palette?.length ? chart.palette : palette;
  const height = HEIGHT_PX[chart.height || "m"];
  if (chart.error) return <p className="py-10 text-center text-[12px]" style={{ color: PBI.sub }}>Couldn&apos;t load this visual. {chart.error}</p>;
  if (!rows.length) return <p className="py-10 text-center text-[12px]" style={{ color: PBI.sub }}>No data for the current filters.</p>;
  if (chart.type === "line" || chart.type === "area")
    return <LineChart rows={rows} x={x} y={y} format={chart.format} height={height} palette={pal} area={chart.type === "area"} />;
  if (chart.type === "pie")
    return <DonutChart rows={rows} x={x} y={y} format={chart.format} height={height} palette={pal} selected={selected} onSelect={onSelect} />;
  if (chart.type === "table") return <TableVisual rows={rows} format={chart.format} height={height} />;
  return <BarChart rows={rows} x={x} y={y} format={chart.format} height={height} palette={pal}
    horizontal={chart.type === "horizontal_bar"} stacked={chart.type === "stacked_bar"} selected={selected} onSelect={onSelect} />;
}

function Visual({ chart, palette, selected, onSelect, onAsk }: {
  chart: AdChart;
  palette: string[];
  selected: Set<string>;
  onSelect?: (value: string) => void;
  onAsk: () => void;
}) {
  const [showSql, setShowSql] = useState(false);
  return (
    <div className={chart.width === "full" ? "xl:col-span-2" : ""}>
      <Tile title={chart.title} subtitle={onSelect ? "Click a data point to filter the page" : undefined}>
        <div className="absolute right-2 top-2 flex gap-1 opacity-60 hover:opacity-100">
          <button type="button" onClick={onAsk} title="Ask about this chart" className="rounded-[2px] px-1.5 py-0.5 text-[11px] hover:bg-[#EDEBE9]">Ask</button>
          <button type="button" onClick={() => setShowSql((s) => !s)} title="Show the query behind this visual"
            className="rounded-[2px] px-1.5 py-0.5 text-[11px] hover:bg-[#EDEBE9]">SQL</button>
        </div>
        <ChartBody chart={chart} palette={palette} selected={selected} onSelect={onSelect} />
        {chart.insight && chart.show_insight !== false && (
          <p className="mt-2 text-[12px] leading-relaxed" style={{ color: PBI.sub }}>{chart.insight}</p>
        )}
        {showSql && (
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-[2px] p-2 text-[11px]" style={{ background: PBI.canvas }}>
            {`-- source: ${chart.source}\n${chart.sql}`}
          </pre>
        )}
      </Tile>
    </div>
  );
}

// ── Edit mode: the dashboard itself becomes editable ─────────────────────────
// Drag a tile by its grip to move it; every change previews at once and is saved as a new version
// (no AI, free). Cancel throws the draft away.

function Seg<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: { v: T; text: ReactNode; title: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex overflow-hidden rounded-[2px]" style={{ border: `1px solid ${PBI.border}` }}>
      {options.map((o) => (
        <button key={o.v} type="button" role="radio" aria-checked={value === o.v} title={o.title} aria-label={o.title} onClick={() => onChange(o.v)}
          className="flex h-7 min-w-[28px] items-center justify-center px-1.5 text-[11px] transition-colors"
          style={value === o.v ? { background: PBI.palette[0], color: "#fff" } : { color: PBI.sub, background: "#fff" }}>
          {o.text}
        </button>
      ))}
    </div>
  );
}

const EDIT_TYPES: ChartType[] = ["bar", "horizontal_bar", "stacked_bar", "line", "area", "pie", "table"];

function EditCanvas({ dash, saving, onSave, onCancel }: {
  dash: AdDash;
  saving: boolean;
  onSave: (p: LayoutPayload) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(dash.title);
  const [subtitle, setSubtitle] = useState(dash.subtitle);
  const [palette, setPalette] = useState<string[]>(dash.palette || []);
  const [kpis, setKpis] = useState<AdKpi[]>(dash.kpis);
  const [charts, setCharts] = useState<AdChart[]>(
    dash.charts.map((c) => ({ ...c, height: c.height || "m", palette: c.palette || [], show_insight: c.show_insight !== false })));
  const [removedK, setRemovedK] = useState<AdKpi[]>([]);
  const [removedC, setRemovedC] = useState<AdChart[]>([]);
  const kDrag = useDragSort(kpis, setKpis);
  const cDrag = useDragSort(charts, setCharts);
  const boxes = useRef<Record<string, HTMLDivElement | null>>({});
  const patch = (id: string, p: Partial<AdChart>) => setCharts((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));
  const field = "min-w-0 rounded-[2px] border bg-white px-2 py-1 outline-none focus:border-[#118DFF]";
  const kpiMin = kpis.length > 4 ? 170 : 210;

  const save = () =>
    onSave({
      title, subtitle, palette,
      kpis: kpis.map((k) => ({ id: k.id, title: k.title })),
      charts: charts.map((c) => ({ id: c.id, title: c.title, type: c.type, width: c.width, height: c.height || "m",
        palette: c.palette || [], show_insight: c.show_insight !== false })),
    });

  return (
    <div className="space-y-3">
      {/* Edit bar */}
      <div className="sticky top-0 z-20 -mx-4 -mt-4 flex flex-wrap items-center justify-between gap-2 border-b bg-white px-4 py-2 shadow-[0_2px_6px_rgba(0,0,0,0.06)]"
        style={{ borderColor: PBI.border }}>
        <div className="flex items-center gap-1 text-[12px]" style={{ color: PBI.sub }}>
          <b style={{ color: PBI.ink }}>Editing</b> · drag <GripIcon /> to move a tile · changes show at once · no AI, free
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <ColorMenu value={palette} onChange={setPalette} label="Theme colours" align="right" />
          <Btn onClick={onCancel} disabled={saving}>Cancel</Btn>
          <Btn primary onClick={save} disabled={saving || (!kpis.length && !charts.length)}>{saving ? "Saving…" : "Save changes"}</Btn>
        </div>
      </div>

      {/* Title */}
      <div className="space-y-1.5 rounded-[4px] bg-white p-3" style={{ border: `1px dashed ${PBI.faint}` }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} aria-label="Dashboard title"
          className={`${field} w-full text-[18px] font-semibold`} style={{ borderColor: PBI.border }} />
        <input value={subtitle} onChange={(e) => setSubtitle(e.target.value)} maxLength={240} aria-label="Subtitle" placeholder="Subtitle"
          className={`${field} w-full text-[12px]`} style={{ borderColor: PBI.border, color: PBI.sub }} />
      </div>

      {/* KPIs */}
      {kpis.length > 0 && (
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${kpiMin}px, 1fr))` }}>
          {kpis.map((k, i) => (
            <div key={k.id} ref={(el) => { boxes.current[k.id] = el; }} {...kDrag.target(k.id)}
              className="rounded-[4px] bg-white" style={{ opacity: kDrag.dragging === k.id ? 0.35 : 1, border: `1px dashed ${PBI.faint}`, transition: "opacity .15s" }}>
              <div className="flex items-center gap-0.5 px-1.5 pt-1.5">
                <span {...kDrag.handle(k.id, () => boxes.current[k.id])} title="Drag to move"
                  className="cursor-grab px-1 active:cursor-grabbing" style={{ color: PBI.sub }}><GripIcon /></span>
                <input value={k.title} maxLength={80} aria-label="KPI title"
                  onChange={(e) => setKpis(kpis.map((x) => (x.id === k.id ? { ...x, title: e.target.value } : x)))}
                  className={`${field} flex-1 text-[12px]`} style={{ borderColor: PBI.border }} />
                <button type="button" onClick={() => kDrag.nudge(k.id, -1)} disabled={i === 0} title="Move left" aria-label={`Move ${k.title} left`}
                  className="px-1 text-[14px] disabled:opacity-30" style={{ color: PBI.sub }}>‹</button>
                <button type="button" onClick={() => kDrag.nudge(k.id, 1)} disabled={i === kpis.length - 1} title="Move right" aria-label={`Move ${k.title} right`}
                  className="px-1 text-[14px] disabled:opacity-30" style={{ color: PBI.sub }}>›</button>
                <button type="button" title="Remove" aria-label={`Remove ${k.title}`}
                  onClick={() => { setKpis(kpis.filter((x) => x.id !== k.id)); setRemovedK((r) => [...r, k]); }}
                  className="px-1 text-[13px] hover:text-[#A4262C]" style={{ color: PBI.sub }}>✕</button>
              </div>
              <KpiCard label={k.title} value={k.value} format={k.format} note={k.note} error={k.error} />
            </div>
          ))}
        </div>
      )}

      {/* Charts */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {charts.map((c, i) => (
          <div key={c.id} ref={(el) => { boxes.current[c.id] = el; }} {...cDrag.target(c.id)}
            className={c.width === "full" ? "xl:col-span-2" : ""}
            style={{ opacity: cDrag.dragging === c.id ? 0.35 : 1, transition: "opacity .15s" }}>
            <section className="relative flex min-w-0 flex-col rounded-[4px] bg-white p-3 shadow-[0_1px_3px_rgba(0,0,0,0.08)]"
              style={{ border: `1px dashed ${PBI.faint}` }}>
              {/* Row 1: grip, title, order, remove */}
              <div className="flex items-center gap-1">
                <span {...cDrag.handle(c.id, () => boxes.current[c.id])} title="Drag to move"
                  className="cursor-grab px-1 active:cursor-grabbing" style={{ color: PBI.sub }}><GripIcon /></span>
                <input value={c.title} maxLength={100} aria-label="Chart title" onChange={(e) => patch(c.id, { title: e.target.value })}
                  className={`${field} flex-1 text-[13px] font-semibold`} style={{ borderColor: PBI.border }} />
                <button type="button" onClick={() => cDrag.nudge(c.id, -1)} disabled={i === 0} title="Move earlier" aria-label={`Move ${c.title} earlier`}
                  className="px-1.5 text-[13px] disabled:opacity-30" style={{ color: PBI.sub }}>↑</button>
                <button type="button" onClick={() => cDrag.nudge(c.id, 1)} disabled={i === charts.length - 1} title="Move later" aria-label={`Move ${c.title} later`}
                  className="px-1.5 text-[13px] disabled:opacity-30" style={{ color: PBI.sub }}>↓</button>
                <button type="button" title="Remove chart" aria-label={`Remove ${c.title}`}
                  onClick={() => { setCharts(charts.filter((x) => x.id !== c.id)); setRemovedC((r) => [...r, c]); }}
                  className="px-1.5 text-[13px] hover:text-[#A4262C]" style={{ color: PBI.sub }}>✕</button>
              </div>
              {/* Row 2: type, size, colours, insight */}
              <div className="mt-2 flex flex-wrap items-center gap-2 border-b pb-2" style={{ borderColor: PBI.grid }}>
                <Seg label="Chart type" value={c.type} onChange={(v) => patch(c.id, { type: v })}
                  options={EDIT_TYPES.map((t) => ({ v: t, text: <TypeGlyph type={t} />, title: TYPE_LABEL[t] }))} />
                <Seg label="Width" value={c.width} onChange={(v) => patch(c.id, { width: v })}
                  options={[{ v: "half" as const, text: "Half", title: "Half width" }, { v: "full" as const, text: "Full", title: "Full width" }]} />
                <Seg label="Height" value={c.height || "m"} onChange={(v) => patch(c.id, { height: v })}
                  options={(["s", "m", "l"] as Height[]).map((h) => ({ v: h, text: h.toUpperCase(), title: `${HEIGHT_LABEL[h]} height` }))} />
                <ColorMenu value={c.palette || []} onChange={(p) => patch(c.id, { palette: p })} inherit inheritColors={palette} />
                {c.insight && (
                  <label className="flex cursor-pointer items-center gap-1 text-[12px]" style={{ color: PBI.sub }}>
                    <input type="checkbox" checked={c.show_insight !== false} onChange={(e) => patch(c.id, { show_insight: e.target.checked })} />
                    Insight
                  </label>
                )}
              </div>
              {c.type === "stacked_bar" && (c.y || []).length < 2 && (
                <p className="mt-1 text-[11px]" style={{ color: PBI.faint }}>This chart has one series, so stacked looks the same as a column chart.</p>
              )}
              <div className="mt-2">
                <ChartBody chart={c} palette={palette} selected={new Set()} />
              </div>
              {c.insight && c.show_insight !== false && (
                <p className="mt-2 text-[12px] leading-relaxed" style={{ color: PBI.sub }}>{c.insight}</p>
              )}
            </section>
          </div>
        ))}
      </div>

      {(removedK.length > 0 || removedC.length > 0) && (
        <div className="rounded-[4px] bg-white p-3 text-[12px]" style={{ border: `1px solid ${PBI.border}` }}>
          <span style={{ color: PBI.sub }}>Removed (click to put back):</span>
          {removedK.map((k) => (
            <button key={k.id} type="button" onClick={() => { setKpis((x) => [...x, k]); setRemovedK((r) => r.filter((y) => y.id !== k.id)); }}
              className="ml-2 rounded-[2px] border px-2 py-0.5 hover:bg-[#F3F2F1]" style={{ borderColor: PBI.border }}>↩ {k.title}</button>
          ))}
          {removedC.map((c) => (
            <button key={c.id} type="button" onClick={() => { setCharts((x) => [...x, c]); setRemovedC((r) => r.filter((y) => y.id !== c.id)); }}
              className="ml-2 rounded-[2px] border px-2 py-0.5 hover:bg-[#F3F2F1]" style={{ borderColor: PBI.border }}>↩ {c.title}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Chat panel ───────────────────────────────────────────────────────────────

function ChatPanel({ state, focus, onFocusClear, onSend, sending }: {
  state: AdState;
  focus: AdChart | null;
  onFocusClear: () => void;
  onSend: (text: string) => void;
  sending: boolean;
}) {
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" }); // returns a Promise in newer browsers: don't return it
  }, [state.history.length, sending]);
  const suggestions = state.language === "Indonesian"
    ? ["Apa temuan terpenting di dashboard ini?", "Tambahkan grafik tren bulanan", "Bandingkan dua kategori teratas"]
    : ["What stands out most on this dashboard?", "Add a monthly trend chart", "Compare the top two categories"];
  const send = () => {
    const t = text.trim();
    if (t.length < 2 || sending) return;
    onSend(t);
    setText("");
  };
  return (
    <aside className="flex max-h-[70vh] w-full shrink-0 flex-col border-t bg-white lg:max-h-none lg:w-[340px] lg:border-l lg:border-t-0"
      style={{ borderColor: PBI.border }}>
      <div className="border-b px-3 py-2" style={{ borderColor: PBI.border }}>
        <div className="text-[14px] font-semibold">Ask or edit</div>
        <div className="text-[11px]" style={{ color: PBI.faint }}>Questions about the data, or changes like “add a chart of …” · 3 credits each</div>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-[13px]">
        {state.history.length === 0 && (
          <div className="space-y-1.5">
            {suggestions.map((s) => (
              <button key={s} type="button" onClick={() => onSend(s)} disabled={sending}
                className="block w-full rounded-[2px] border px-2.5 py-1.5 text-left text-[12px] hover:bg-[#F3F2F1]" style={{ borderColor: PBI.border }}>
                {s}
              </button>
            ))}
          </div>
        )}
        {state.history.map((t, i) => (
          <div key={i} className={t.role === "user" ? "ml-6 rounded-[4px] px-3 py-2" : "mr-2"}
            style={t.role === "user" ? { background: "#E8F3FF" } : undefined}>
            {t.role === "assistant" ? (
              <>
                {t.action === "edit" && (
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: "#107C10" }}>Dashboard updated</div>
                )}
                <Markdown compact>{t.content}</Markdown>
                {!!t.queries?.length && (
                  <details className="mt-1 text-[11px]" style={{ color: PBI.sub }}>
                    <summary className="cursor-pointer">{t.queries.length} quer{t.queries.length > 1 ? "ies" : "y"} run</summary>
                    {t.queries.map((q, j) => (
                      <pre key={j} className="mt-1 whitespace-pre-wrap rounded-[2px] p-1.5" style={{ background: PBI.canvas }}>
                        {`-- ${q.source}, ${q.ok ? `${q.rows} rows` : `error: ${q.error}`}\n${q.sql}`}
                      </pre>
                    ))}
                  </details>
                )}
              </>
            ) : t.content}
          </div>
        ))}
        {sending && <div className="animate-pulse text-[12px]" style={{ color: PBI.sub }}>Thinking…</div>}
        <div ref={end} />
      </div>
      <div className="border-t p-2" style={{ borderColor: PBI.border }}>
        {focus && (
          <div className="mb-1 flex items-center justify-between rounded-[2px] px-2 py-1 text-[11px]" style={{ background: "#E8F3FF" }}>
            <span className="truncate">About: {focus.title}</span>
            <button type="button" onClick={onFocusClear} aria-label="Stop asking about this chart">✕</button>
          </div>
        )}
        <div className="flex gap-1">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={2000} aria-label="Message"
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder={focus ? "Ask about this chart…" : "Ask a question or describe a change…"}
            className="min-w-0 flex-1 resize-none rounded-[2px] border px-2 py-1 text-[13px] outline-none focus:border-[#118DFF]"
            style={{ borderColor: PBI.border }} />
          <Btn primary onClick={send} disabled={sending || text.trim().length < 2}>Send</Btn>
        </div>
      </div>
    </aside>
  );
}

// ── Main view ────────────────────────────────────────────────────────────────

export function AutoDashboardView() {
  const [list, setList] = useState<AdSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [state, setState] = useState<AdState | null>(null);
  const [dash, setDash] = useState<AdDash | null>(null);
  const [sel, setSel] = useState<Sel>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [chatOpen, setChatOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [focus, setFocus] = useState<AdChart | null>(null);
  const [exporting, setExporting] = useState("");
  const skipRender = useRef(true);

  const loadList = useCallback(async () => {
    try {
      const l = await getJSON<AdSummary[]>("/api/autodash");
      setList(l);
      return l;
    } catch (e) {
      setError(errorText(e));
      return [];
    }
  }, []);

  useEffect(() => {
    loadList().then((l) => {
      if (l[0]) setActiveId(l[0].id);
      else setCreating(true);
    });
  }, [loadList]);

  const open = useCallback(async (id: string) => {
    setError("");
    setEditing(false);
    setFocus(null);
    try {
      const s = await getJSON<AdState>(`/api/autodash/${id}`);
      skipRender.current = true;
      setState(s);
      setDash(s.dashboard);
      setSel({});
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    if (activeId && !creating) open(activeId);
  }, [activeId, creating, open]);

  // A dashboard still building (e.g. after switching apps): keep its progress fresh.
  const buildingId = state?.status === "building" ? state.id : null;
  useEffect(() => {
    if (!buildingId) return;
    const t = setInterval(async () => {
      try {
        const s = await getJSON<AdState>(`/api/autodash/${buildingId}`);
        if (s.status !== "building") {
          skipRender.current = true;
          setDash(s.dashboard);
          loadList();
        }
        setState(s);
      } catch {
        /* keep polling */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [buildingId, loadList]);

  // Filters re-run the saved queries (no AI).
  const readyId = state?.status === "ready" ? state.id : null;
  useEffect(() => {
    if (!readyId) return;
    if (skipRender.current) {
      skipRender.current = false;
      return;
    }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        setDash(await postJSON<AdDash>(`/api/autodash/${readyId}/render`, { filters: sel }));
      } catch (e) {
        setError(errorText(e));
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [sel, readyId]);

  const started = async (jobId: string, id: string) => {
    setCreating(false);
    setActiveId(id);
    await loadList();
    const j = await pollJob(jobId).catch((e): AdJob => ({ id: jobId, status: "failed", error: errorText(e) }));
    await loadList();
    if (j.state) {
      skipRender.current = true;
      setState(j.state);
      setDash(j.state.dashboard);
    }
    if (j.status === "failed") setError(j.error || "The build failed.");
  };

  const setFilter = (id: string, values: string[]) =>
    setSel((s) => {
      const next = { ...s };
      if (values.length) next[id] = values;
      else delete next[id];
      return next;
    });

  const crossFilter = (filterId: string, value: string) => {
    const cur = sel[filterId] || [];
    setFilter(filterId, cur.length === 1 && cur[0] === value ? [] : [value]);
  };

  const sendChat = async (message: string) => {
    if (!state) return;
    setSending(true);
    setError("");
    setState({ ...state, history: [...state.history, { role: "user", content: message, chart_id: focus?.id }] });
    try {
      const { job_id } = await postJSON<{ job_id: string }>(`/api/autodash/${state.id}/chat`,
        { message, filters: sel, chart_id: focus?.id || "" });
      const j = await pollJob(job_id);
      if (j.state) {
        skipRender.current = true;
        setState(j.state);
        if (j.dashboard) setDash(j.dashboard);
      }
      if (j.status === "failed") setError(j.error || "That didn't work.");
      if (j.action === "edit") loadList();
    } catch (e) {
      setError(errorText(e));
      open(state.id);
    } finally {
      setSending(false);
      setFocus(null);
    }
  };

  const saveLayout = async (p: LayoutPayload) => {
    if (!state) return;
    setSaving(true);
    try {
      const s = await postJSON<AdState & { dashboard: AdDash }>(`/api/autodash/${state.id}/layout`, { ...p, filters: sel });
      skipRender.current = true;
      setState(s);
      setDash(s.dashboard);
      setEditing(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  /** Theme colours straight from the header: saved at once as a new version (no AI). */
  const applyPalette = (palette: string[]) => {
    if (!dash) return;
    saveLayout({
      title: dash.title, subtitle: dash.subtitle, palette,
      kpis: dash.kpis.map((k) => ({ id: k.id, title: k.title })),
      charts: dash.charts.map((c) => ({ id: c.id, title: c.title, type: c.type, width: c.width, height: c.height || "m",
        palette: c.palette || [], show_insight: c.show_insight !== false })),
    });
  };

  const restore = async (version: number) => {
    if (!state || version < 1) return;
    try {
      const s = await postJSON<AdState>(`/api/autodash/${state.id}/restore`, { version });
      skipRender.current = true;
      setState(s);
      setDash(s.dashboard);
      setSel({});
    } catch (e) {
      setError(errorText(e));
    }
  };

  const exportAs = async (format: "xlsx" | "pptx") => {
    if (!state) return;
    setExporting(format);
    try {
      const res = await fetch(`/api/autodash/${state.id}/export`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filters: sel, format }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `Export failed (${res.status})`);
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "")?.[1] || `dashboard.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setExporting("");
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("Delete this dashboard? This cannot be undone.")) return;
    try {
      await del(`/api/autodash/${id}`);
      const l = await loadList();
      if (id === activeId) {
        setState(null);
        setDash(null);
        if (l[0]) setActiveId(l[0].id);
        else {
          setActiveId(null);
          setCreating(true);
        }
      }
    } catch (e) {
      setError(errorText(e));
    }
  };

  setCurrency(dash?.currency);
  const kpiMin = (dash?.kpis.length || 0) > 4 ? 160 : 200;
  const activeSel = Object.keys(sel).length;
  const dateFilters = useMemo(() => (dash?.filters || []).filter((f) => f.kind === "date"), [dash]);
  const catFilters = useMemo(() => (dash?.filters || []).filter((f) => f.kind === "category"), [dash]);
  const sourceLine = state
    ? [
        ...state.sources.files,
        ...(state.sources.db ? [`${state.sources.db.engine} · ${state.sources.db.database}`] : []),
        ...state.sources.imports.map((i) => `${i} (import)`),
      ].join(" · ")
    : "";

  return (
    <div className="flex h-full min-h-[640px] flex-col lg:flex-row" style={{ background: PBI.canvas, fontFamily: PBI.font, color: PBI.ink }}>
      {/* Dashboards list */}
      <nav className="flex shrink-0 flex-col border-b bg-white lg:w-56 lg:border-b-0 lg:border-r" style={{ borderColor: PBI.border }}>
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-[13px] font-semibold">Dashboards</span>
          <Btn primary onClick={() => { setCreating(true); setEditing(false); }}>+ New</Btn>
        </div>
        <div className="flex gap-1 overflow-x-auto px-2 pb-2 lg:block lg:space-y-0.5 lg:overflow-y-auto">
          {list.map((d) => (
            <div key={d.id} className="group flex shrink-0 items-center">
              <button type="button" onClick={() => { setCreating(false); setActiveId(d.id); }}
                className="min-w-0 flex-1 truncate rounded-[2px] px-2 py-1.5 text-left text-[12px]"
                style={d.id === activeId && !creating ? { background: "#E8F3FF", fontWeight: 600 } : undefined}
                title={d.sources.join(", ")}>
                {d.status === "building" ? "⏳ " : d.status === "failed" ? "⚠ " : ""}{d.title}
              </button>
              <button type="button" onClick={() => remove(d.id)} title="Delete" aria-label={`Delete ${d.title}`}
                className="px-1 text-[12px] opacity-0 group-hover:opacity-100 focus:opacity-100" style={{ color: PBI.faint }}>×</button>
            </div>
          ))}
          {!list.length && <p className="px-2 text-[12px]" style={{ color: PBI.faint }}>No dashboards yet.</p>}
        </div>
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {creating ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-4">
            {error && <div className="mx-auto mt-4 max-w-3xl"><Notice>{error}</Notice></div>}
            <CreatePanel onStarted={started} />
          </div>
        ) : !state ? (
          <div className="p-6 text-[13px]" style={{ color: PBI.sub }}>{error ? <Notice>{error}</Notice> : "Loading…"}</div>
        ) : state.status === "building" ? (
          <Building progress={state.progress} />
        ) : state.status === "failed" || !dash ? (
          <div className="mx-auto mt-16 max-w-md px-4">
            <Notice>{state.error || error || "This dashboard could not be built."}</Notice>
            <Btn primary onClick={() => setCreating(true)}>Create a new dashboard</Btn>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-white px-5 py-3" style={{ borderColor: PBI.border }}>
              <div className="min-w-0">
                <h2 className="truncate text-[20px] font-semibold">{dash.title}</h2>
                <p className="truncate text-[12px]" style={{ color: PBI.sub }} title={dash.strategy}>{dash.subtitle || sourceLine}</p>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <Btn onClick={() => setSel({})} disabled={!activeSel}>Reset filters</Btn>
                <Btn onClick={() => restore(state.version - 1)} disabled={state.version <= 1} title="Go back one version">Undo</Btn>
                {state.versions > 1 && (
                  <select value={state.version} onChange={(e) => restore(Number(e.target.value))} aria-label="Version"
                    className="rounded-[2px] border bg-white px-1 py-1 text-[12px]" style={{ borderColor: PBI.border }}>
                    {Array.from({ length: state.versions }, (_, i) => i + 1).map((v) => <option key={v} value={v}>Version {v}</option>)}
                  </select>
                )}
                {!editing && <ColorMenu value={dash.palette || []} onChange={applyPalette} label="Colours" align="right" />}
                <Btn onClick={() => setEditing((e) => !e)} active={editing}>{editing ? "Editing…" : "Edit dashboard"}</Btn>
                <Btn onClick={() => exportAs("xlsx")} disabled={!!exporting}>{exporting === "xlsx" ? "Exporting…" : "Excel"}</Btn>
                <Btn onClick={() => exportAs("pptx")} disabled={!!exporting}>{exporting === "pptx" ? "Exporting…" : "PowerPoint"}</Btn>
                <Btn onClick={() => setChatOpen((o) => !o)} active={chatOpen}>Chat</Btn>
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
              <div className="min-w-0 flex-1 overflow-y-auto p-4">
                {error && <Notice>{error}</Notice>}
                {dash.notes.length > 0 && <Notice tone="info">{dash.notes.join(" · ")}</Notice>}

                {editing ? (
                  <EditCanvas key={`${state.id}-${state.version}`} dash={dash} saving={saving} onCancel={() => setEditing(false)} onSave={saveLayout} />
                ) : (
                  <div className="space-y-3">
                    {(catFilters.length > 0 || dateFilters.length > 0) && (
                      <div className="flex flex-wrap gap-3">
                        {dateFilters.map((f) => {
                          const [lo, hi] = f.options as string[];
                          const cur = sel[f.id] || [lo, hi];
                          const set = (i: number, v: string) => {
                            const next = [...cur];
                            next[i] = v || (i === 0 ? lo : hi);
                            setFilter(f.id, next[0] === lo && next[1] === hi ? [] : next);
                          };
                          return (
                            <div key={f.id} className="min-w-[250px] flex-1">
                              <Tile>
                                <div className="text-[12px] font-semibold">{f.label}</div>
                                <div className="mt-1 flex items-center gap-1 text-[12px]">
                                  <input type="date" min={lo} max={hi} value={cur[0]} onChange={(e) => set(0, e.target.value)} aria-label={`${f.label} from`}
                                    className="min-w-0 flex-1 rounded-[2px] border px-1 py-0.5" style={{ borderColor: PBI.border }} />
                                  <span style={{ color: PBI.faint }}>to</span>
                                  <input type="date" min={lo} max={hi} value={cur[1]} onChange={(e) => set(1, e.target.value)} aria-label={`${f.label} to`}
                                    className="min-w-0 flex-1 rounded-[2px] border px-1 py-0.5" style={{ borderColor: PBI.border }} />
                                </div>
                              </Tile>
                            </div>
                          );
                        })}
                        {catFilters.map((f) => (
                          <Slicer key={f.id} label={f.label} options={f.options as { value: string; count: number }[]}
                            value={sel[f.id] || []} onChange={(v) => setFilter(f.id, v)} />
                        ))}
                      </div>
                    )}

                    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${kpiMin}px, 1fr))`, opacity: loading ? 0.6 : 1 }}>
                      {dash.kpis.map((k) => (
                        <KpiCard key={k.id} label={k.title} value={k.value} format={k.format} note={k.note} error={k.error} />
                      ))}
                    </div>

                    {state.quality && (state.quality.issues?.length ?? 0) > 0 && (
                      <details className="rounded-[4px] bg-white p-3 shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
                        <summary className="cursor-pointer text-[13px] font-semibold">
                          Data quality: {state.quality.score}/100 · {state.quality.issues.length} issue(s) — fix with one click (free, no AI)
                        </summary>
                        <div className="mt-2">
                          {(state.quality_log ?? []).map((l) => (
                            <div key={l.at + l.fix} className="text-[12px] text-[#107C10]">✓ {l.fix}</div>
                          ))}
                          <QualityReport
                            q={state.quality}
                            onFix={async (fx) => {
                              try {
                                const s = await postJSON<AdState>(`/api/autodash/${state.id}/quality/fix`, fx);
                                setState(s);
                                setDash(s.dashboard);
                              } catch (e) {
                                setError(errorText(e));
                              }
                            }}
                          />
                        </div>
                      </details>
                    )}

                    <div className="max-w-md rounded-[4px] bg-white p-3 shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
                      <OpenStudio prefix={`/api/autodash/${state.id}/studio`} label="Edit as PowerPoint or Word"
                        note="Native charts and tables from this dashboard; format, add pictures, tables and charts; export .pptx / .docx / PDF." />
                    </div>

                    {dash.summary && (
                      <Tile title="Key findings">
                        <div className="text-[13px]"><Markdown compact>{dash.summary}</Markdown></div>
                      </Tile>
                    )}

                    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2" style={{ opacity: loading ? 0.6 : 1, transition: "opacity .15s" }}>
                      {dash.charts.map((c) => (
                        <Visual key={c.id} chart={c} palette={dash.palette || []}
                          selected={new Set(c.filter_id ? sel[c.filter_id] || [] : [])}
                          onSelect={c.filter_id ? (v) => crossFilter(c.filter_id, v) : undefined}
                          onAsk={() => { setFocus(c); setChatOpen(true); }} />
                      ))}
                    </div>

                    <p className="pt-2 text-[11px]" style={{ color: PBI.faint }}>
                      {sourceLine} · designed by Claude Haiku 5.5
                      {state.usage.calls ? ` in ${state.usage.calls} calls` : ""} · every query is checked read-only before it runs ·
                      filters, layout edits, undo and exports use no AI
                      {dash.refreshed_at ? ` · refreshed ${new Date(dash.refreshed_at).toLocaleTimeString()}` : ""}
                    </p>
                  </div>
                )}
              </div>

              {chatOpen && (
                <ChatPanel state={state} focus={focus} onFocusClear={() => setFocus(null)} onSend={sendChat} sending={sending} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
