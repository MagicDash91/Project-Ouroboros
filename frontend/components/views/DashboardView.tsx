"use client";

// Power BI–style report page for the automatic dashboards. Claude designs each
// dashboard once (server side); everything here — slicers, cross-filtering,
// refresh — only re-runs the saved SQL, so it costs no LLM tokens.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { BarChart, DonutChart, KpiCard, LineChart, PBI, Slicer, TableVisual, Tile, fmt, setCurrency } from "@/components/dashboard/pbi";
import { del, errorText, getJSON, postJSON } from "@/lib/api";
import type { Dashboard, DashboardData, DashboardSummary, DashChart } from "@/lib/types";

type Filters = Record<string, string[]>;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function Btn({ children, onClick, active, disabled, title }: {
  children: ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title}
      className="rounded-[2px] px-2.5 py-1 text-[12px] transition-colors hover:bg-[#EDEBE9] disabled:opacity-40"
      style={{ color: PBI.ink, background: active ? "#EDEBE9" : undefined }}>
      {children}
    </button>
  );
}

function Visual({ chart, rows, error, filterCol, selected, onSelect }: {
  chart: DashChart;
  rows: Record<string, unknown>[];
  error?: string;
  filterCol?: string;
  selected: Set<string>;
  onSelect: (col: string, value: string) => void;
}) {
  const format = chart.y_format || "number";
  const select = filterCol ? (v: string) => onSelect(filterCol, v) : undefined;
  let body: ReactNode;
  if (error) body = <p className="py-10 text-center text-[12px]" style={{ color: PBI.sub }}>Couldn&apos;t load this visual. {error}</p>;
  else if (!rows.length) body = <p className="py-10 text-center text-[12px]" style={{ color: PBI.sub }}>No data for the current filters.</p>;
  else if (chart.type === "line") body = <LineChart rows={rows} x={chart.x} y={chart.y} format={format} />;
  else if (chart.type === "pie") body = <DonutChart rows={rows} x={chart.x} y={chart.y} format={format} selected={selected} onSelect={select} />;
  else if (chart.type === "table") body = <TableVisual rows={rows} format={format} />;
  else body = <BarChart rows={rows} x={chart.x} y={chart.y} format={format} horizontal={chart.type === "hbar"} selected={selected} onSelect={select} />;
  return <Tile title={chart.title} subtitle={chart.note}>{body}</Tile>;
}

export function DashboardView({ dashboardId }: { dashboardId?: string | null }) {
  const [list, setList] = useState<DashboardSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [data, setData] = useState<DashboardData | null>(null);
  const [filters, setFilters] = useState<Filters>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [paneOpen, setPaneOpen] = useState(true);
  const [creating, setCreating] = useState(false);
  const [askBrief, setAskBrief] = useState(false);
  const [brief, setBrief] = useState("");

  const loadList = useCallback(async () => {
    try {
      const l = await getJSON<DashboardSummary[]>("/api/dashboards");
      setList(l);
      return l;
    } catch (e) {
      setError(errorText(e));
      return [];
    }
  }, []);

  // Open the run's dashboard when one exists, otherwise the most recent page.
  useEffect(() => {
    loadList().then((l) => setActiveId((cur) => dashboardId || cur || l[0]?.id || null));
  }, [loadList, dashboardId]);

  useEffect(() => {
    if (!activeId) return;
    setDash(null);
    setData(null);
    setFilters({});
    getJSON<Dashboard>(`/api/dashboards/${activeId}`).then(setDash).catch((e) => setError(errorText(e)));
  }, [activeId]);

  const refresh = useCallback(async () => {
    if (!activeId) return;
    setLoading(true);
    setError("");
    try {
      setData(await postJSON<DashboardData>(`/api/dashboards/${activeId}/data`, { filters }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [activeId, filters]);

  useEffect(() => {
    if (dash) refresh();
  }, [dash, refresh]);

  const setFilter = (col: string, values: string[]) =>
    setFilters((f) => {
      const next = { ...f };
      if (values.length) next[col] = values;
      else delete next[col];
      return next;
    });

  // Cross-filtering: clicking a data point toggles it as a filter, like Power BI.
  const crossFilter = (col: string, value: string) => {
    const cur = filters[col] || [];
    setFilter(col, cur.length === 1 && cur[0] === value ? [] : [value]);
  };

  // A visual cross-filters when its category axis is one of the slicer columns.
  const filterColFor = useMemo(() => {
    const byNorm = new Map((dash?.spec.filters || []).map((f) => [norm(f), f]));
    return (c: DashChart) => byNorm.get(norm(c.x));
  }, [dash]);

  const create = async () => {
    setCreating(true);
    setError("");
    try {
      const d = await postJSON<Dashboard>("/api/dashboards", { brief });
      await loadList();
      setActiveId(d.id);
      setAskBrief(false);
      setBrief("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setCreating(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("Delete this dashboard page?")) return;
    try {
      await del(`/api/dashboards/${id}`);
      const l = await loadList();
      if (id === activeId) setActiveId(l[0]?.id || null);
    } catch (e) {
      setError(errorText(e));
    }
  };

  setCurrency(dash?.spec.currency); // money formats follow this dashboard's currency
  const kpiValue = (id: string) => data?.kpis.find((k) => k.id === id);
  const chartData = (id: string) => data?.charts.find((c) => c.id === id);
  const activeFilters = Object.entries(filters);
  const kpiCols = Math.min(Math.max(dash?.spec.kpis.length || 1, 2), 6);

  return (
    <div className="flex h-full min-h-[640px] flex-col" style={{ background: PBI.canvas, fontFamily: PBI.font, color: PBI.ink }}>
      {/* Report header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-white px-5 py-3" style={{ borderColor: PBI.border }}>
        <div className="min-w-0">
          <h2 className="truncate text-[20px] font-semibold">{dash?.spec.title || "Dashboard"}</h2>
          <p className="truncate text-[12px]" style={{ color: PBI.sub }}>
            {dash?.spec.summary || "Automatically designed from your data after each analysis run."}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {data && (
            <span className="mr-2 text-[12px]" style={{ color: PBI.sub }}>
              {fmt(data.row_count, "number", true)} rows · refreshed {new Date(data.refreshed_at).toLocaleTimeString()}
            </span>
          )}
          <Btn onClick={() => setFilters({})} disabled={!activeFilters.length} title="Clear all slicers and cross-filters">Reset filters</Btn>
          <Btn onClick={refresh} disabled={!dash || loading}>{loading ? "Refreshing…" : "Refresh"}</Btn>
          <Btn onClick={() => setPaneOpen((o) => !o)} active={paneOpen}>Filters</Btn>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Canvas */}
        <div className="min-w-0 flex-1 overflow-y-auto p-4">
          {error && (
            <div className="mb-3 rounded-[2px] border px-3 py-2 text-[12px]" style={{ borderColor: "#D64550", color: "#A4262C", background: "#FDE7E9" }}>
              {error}
            </div>
          )}

          {!activeId && !creating && (
            <div className="mx-auto mt-16 max-w-md rounded-[4px] bg-white p-8 text-center shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
              <h3 className="text-[16px] font-semibold">No dashboard yet</h3>
              <p className="mt-2 text-[13px]" style={{ color: PBI.sub }}>
                One is designed automatically when an analysis run finishes. You can also create one now from the connected database.
              </p>
              <button type="button" onClick={() => setAskBrief(true)}
                className="mt-4 rounded-[2px] px-4 py-1.5 text-[13px] font-semibold text-white" style={{ background: PBI.palette[0] }}>
                Create dashboard
              </button>
            </div>
          )}

          {dash && (
            <div className="space-y-3">
              {dash.spec.filters.length > 0 && (
                <div className="flex flex-wrap gap-3">
                  {dash.spec.filters.map((col) => (
                    <Slicer key={col} label={col} options={data?.filters[col] || []} value={filters[col] || []}
                      onChange={(v) => setFilter(col, v)} />
                  ))}
                </div>
              )}

              <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${kpiCols > 4 ? 150 : 190}px, 1fr))` }}>
                {dash.spec.kpis.map((k) => {
                  const v = kpiValue(k.id);
                  return <KpiCard key={k.id} label={k.label} value={v?.value} format={k.format} note={k.note} error={v?.error} />;
                })}
              </div>

              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2" style={{ opacity: loading && data ? 0.6 : 1, transition: "opacity .15s" }}>
                {dash.spec.charts.map((c) => {
                  const col = filterColFor(c);
                  const cd = chartData(c.id);
                  return (
                    <Visual key={c.id} chart={c} rows={cd?.rows || []} error={cd?.error} filterCol={col}
                      selected={new Set(col ? filters[col] || [] : [])} onSelect={crossFilter} />
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Filters pane */}
        {paneOpen && dash && (
          <aside className="hidden w-64 shrink-0 overflow-y-auto border-l bg-white p-3 md:block" style={{ borderColor: PBI.border }}>
            <h3 className="mb-3 text-[14px] font-semibold">Filters</h3>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: PBI.sub }}>Filters on this page</div>
            {dash.spec.filters.map((col) => {
              const vals = filters[col] || [];
              return (
                <div key={col} className="mb-2 rounded-[2px] p-2.5" style={{ background: PBI.canvas }}>
                  <div className="flex items-center justify-between text-[12px] font-semibold">
                    {col}
                    {vals.length > 0 && (
                      <button type="button" className="text-[11px] font-normal hover:underline" style={{ color: PBI.palette[0] }}
                        onClick={() => setFilter(col, [])}>Clear</button>
                    )}
                  </div>
                  <div className="mt-0.5 text-[12px]" style={{ color: PBI.sub }}>{vals.length ? `is ${vals.join(", ")}` : "is (All)"}</div>
                </div>
              );
            })}
            {dash.llm_usage && (
              <p className="mt-4 text-[11px] leading-relaxed" style={{ color: PBI.faint }}>
                Designed by Claude Haiku 5.5 from table “{dash.source.table}” using{" "}
                {fmt(dash.llm_usage.input_tokens + dash.llm_usage.output_tokens, "number", true)} tokens. Filtering and refreshing use no AI.
              </p>
            )}
          </aside>
        )}
      </div>

      {/* Page tabs */}
      <div className="flex items-center gap-1 overflow-x-auto border-t px-2 py-1" style={{ borderColor: PBI.border, background: "#E1DFDD" }}>
        {list.map((d) => (
          <div key={d.id} className="group flex shrink-0 items-center">
            <button type="button" onClick={() => setActiveId(d.id)} title={`${d.title} · ${d.table}`}
              className="max-w-[220px] truncate rounded-t-[2px] px-3 py-1.5 text-[12px]"
              style={d.id === activeId
                ? { background: "#fff", fontWeight: 600, boxShadow: "inset 0 -3px 0 #F2C811" }
                : { color: PBI.sub }}>
              {d.title}
            </button>
            <button type="button" onClick={() => remove(d.id)} title="Delete page"
              className="hidden px-1 text-[12px] group-hover:block" style={{ color: PBI.faint }}>×</button>
          </div>
        ))}
        {askBrief ? (
          <form className="flex shrink-0 items-center gap-1 px-2" onSubmit={(e) => { e.preventDefault(); create(); }}>
            <input autoFocus value={brief} onChange={(e) => setBrief(e.target.value)} disabled={creating}
              placeholder="Optional focus, e.g. revenue at risk by segment"
              className="w-72 rounded-[2px] border bg-white px-2 py-1 text-[12px] outline-none focus:border-[#118DFF]"
              style={{ borderColor: PBI.border }} />
            <Btn onClick={create} disabled={creating}>{creating ? "Designing… (~30s)" : "Create"}</Btn>
            {!creating && <Btn onClick={() => setAskBrief(false)}>Cancel</Btn>}
          </form>
        ) : (
          <button type="button" onClick={() => setAskBrief(true)} title="New dashboard page (one Claude call)"
            className="shrink-0 px-3 py-1.5 text-[16px] leading-none" style={{ color: PBI.sub }}>+</button>
        )}
      </div>
    </div>
  );
}
