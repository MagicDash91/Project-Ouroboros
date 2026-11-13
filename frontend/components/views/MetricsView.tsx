"use client";

// Metrics (the semantic layer: one definition of "revenue" for every feature) and the
// Data-quality checker (upload a file → issues → one-click fixes → download the cleaned file).

import { useEffect, useRef, useState } from "react";
import { del, errorText, getJSON, postForm, postJSON, putJSON } from "@/lib/api";
import { cx } from "@/components/ui";

interface Metric {
  id?: string;
  name: string;
  aliases: string[];
  description: string;
  expression: string;
  filter: string;
  table_hint: string;
  format: "number" | "currency" | "percent";
  currency: string;
}
interface Issue {
  id: string;
  table: string;
  column: string;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  count: number;
  fix: ({ label: string } & Record<string, unknown>) | null;
}
export interface Quality {
  score: number;
  issues: Issue[];
  checked_at?: string;
}

const EMPTY: Metric = { name: "", aliases: [], description: "", expression: "", filter: "", table_hint: "", format: "number", currency: "" };
const SEV = { high: "bg-[#FDE7E9] text-[#A4262C]", medium: "bg-[#FFF4CE] text-[#7A5B00]", low: "bg-[#EDEBE9] text-[#605E5C]" };
const field = "w-full border border-rule bg-white px-2 py-1.5 text-[13px] outline-none focus:border-ink";

/** Issues list with one-click fixes (used here and in Auto Dashboard). */
export function QualityReport({ q, onFix, busy }: { q: Quality; onFix?: (fix: Record<string, unknown>) => void; busy?: boolean }) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-3">
        <span className={cx("font-mono text-[22px] font-semibold", q.score >= 85 ? "text-[#107C10]" : q.score >= 60 ? "text-[#7A5B00]" : "text-[#A4262C]")}>
          {q.score}/100
        </span>
        <span className="text-[12px] text-mute">{q.issues.length ? `${q.issues.length} issue${q.issues.length > 1 ? "s" : ""} found` : "No problems found"}</span>
      </div>
      {q.issues.map((i) => (
        <div key={i.id} className="flex items-start gap-2 border border-rule bg-white px-3 py-2">
          <span className={cx("mt-0.5 shrink-0 rounded-[2px] px-1.5 py-0.5 font-mono text-[9.5px] uppercase", SEV[i.severity])}>{i.severity}</span>
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium text-ink">
              <span className="text-mute">{i.table} · </span>
              {i.title}
            </div>
            <div className="text-[11.5px] text-graphite">{i.detail}</div>
          </div>
          {i.fix && onFix && (
            <button
              disabled={busy}
              onClick={() => onFix(i.fix as Record<string, unknown>)}
              className="shrink-0 border border-ink px-2 py-1 text-[11px] hover:bg-ink hover:text-paper disabled:opacity-40"
            >
              {i.fix.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function MetricForm({ initial, dashboards, onSaved, onCancel }: {
  initial: Metric;
  dashboards: { id: string; title: string }[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [m, setM] = useState<Metric>(initial);
  const [err, setErr] = useState("");
  const [dash, setDash] = useState(dashboards[0]?.id ?? "");
  const [test, setTest] = useState<{ value?: unknown; error?: string; sql?: string } | null>(null);
  const set = (p: Partial<Metric>) => setM((x) => ({ ...x, ...p }));
  const save = async () => {
    setErr("");
    try {
      if (m.id) await putJSON(`/api/metrics/${m.id}`, m);
      else await postJSON("/api/metrics", m);
      onSaved();
    } catch (e) {
      setErr(errorText(e));
    }
  };
  const runTest = async () => {
    setTest(null);
    try {
      setTest(await postJSON("/api/metrics/test", { metric: m, dashboard_id: dash }));
    } catch (e) {
      setTest({ error: errorText(e) });
    }
  };
  return (
    <div className="space-y-2 border border-ink bg-white p-4">
      <div className="grid grid-cols-2 gap-2">
        <input className={field} placeholder="Name, e.g. Net revenue" value={m.name} onChange={(e) => set({ name: e.target.value })} />
        <input className={field} placeholder="Also called (comma separated), e.g. omzet, penjualan bersih" value={m.aliases.join(", ")}
          onChange={(e) => set({ aliases: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
      </div>
      <input className={cx(field, "font-mono")} placeholder="Formula, e.g. SUM(net_revenue) or COUNT(DISTINCT customer_id)" value={m.expression}
        onChange={(e) => set({ expression: e.target.value })} />
      <input className={cx(field, "font-mono")} placeholder="Only count rows where… (optional), e.g. status = 'paid'" value={m.filter}
        onChange={(e) => set({ filter: e.target.value })} />
      <textarea className={field} rows={2} placeholder="What it means (shown to Claude and to your team)" value={m.description}
        onChange={(e) => set({ description: e.target.value })} />
      <div className="flex flex-wrap gap-2">
        <select className="border border-rule bg-white px-2 py-1.5 text-[13px]" value={m.format} onChange={(e) => set({ format: e.target.value as Metric["format"] })}>
          <option value="number">Number</option>
          <option value="currency">Currency</option>
          <option value="percent">Percent</option>
        </select>
        {m.format === "currency" && (
          <input className="w-24 border border-rule bg-white px-2 py-1.5 text-[13px]" placeholder="IDR" value={m.currency}
            onChange={(e) => set({ currency: e.target.value.toUpperCase() })} />
        )}
        <input className="min-w-[180px] flex-1 border border-rule bg-white px-2 py-1.5 text-[13px]" placeholder="Usual table (optional)" value={m.table_hint}
          onChange={(e) => set({ table_hint: e.target.value })} />
      </div>
      {dashboards.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-rule pt-2 text-[12px]">
          <span className="text-mute">Test on</span>
          <select className="border border-rule bg-white px-1 py-1" value={dash} onChange={(e) => setDash(e.target.value)}>
            {dashboards.map((d) => (
              <option key={d.id} value={d.id}>{d.title}</option>
            ))}
          </select>
          <button onClick={runTest} className="border border-rule px-2 py-1 hover:border-ink">Run test</button>
          {test && (
            <span className={test.error ? "text-signal" : "text-ink"}>
              {test.error ? test.error : <>= <b>{String(test.value)}</b> <span className="font-mono text-[10.5px] text-mute">({test.sql})</span></>}
            </span>
          )}
        </div>
      )}
      {err && <p className="text-[12px] text-signal">{err}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-3 py-1.5 text-[12px] text-graphite hover:text-ink">Cancel</button>
        <button onClick={save} className="bg-ink px-4 py-1.5 text-[12px] font-medium text-paper hover:bg-signal">Save metric</button>
      </div>
    </div>
  );
}

function MetricsTab() {
  const [list, setList] = useState<Metric[]>([]);
  const [editing, setEditing] = useState<Metric | null>(null);
  const [dashboards, setDashboards] = useState<{ id: string; title: string }[]>([]);
  const [sugg, setSugg] = useState<Metric[]>([]);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const load = () => getJSON<Metric[]>("/api/metrics").then(setList).catch((e) => setErr(errorText(e)));
  useEffect(() => {
    load();
    getJSON<{ id: string; title: string; status: string }[]>("/api/autodash")
      .then((l) => setDashboards(l.filter((d) => d.status === "ready")))
      .catch(() => {});
  }, []);
  const suggest = async (id: string) => {
    setBusy("Claude is reading the data…");
    setErr("");
    try {
      setSugg((await postJSON<{ metrics: Metric[] }>("/api/metrics/suggest", { dashboard_id: id })).metrics);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy("");
    }
  };
  const accept = async (m: Metric) => {
    try {
      await postJSON("/api/metrics", m);
      setSugg((s) => s.filter((x) => x !== m));
      load();
    } catch (e) {
      setErr(errorText(e));
    }
  };
  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-[13px] leading-relaxed text-graphite">
        Define each business number once. Data chat, Agent, Dashboards, Analytics runs and the Workflow builder all compute it exactly this way
        whenever someone asks for it by name or alias, so “revenue” never means two different things.
      </p>
      {err && <p className="text-[12px] text-signal">{err}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setEditing({ ...EMPTY })} className="bg-ink px-3 py-1.5 text-[12px] font-medium text-paper hover:bg-signal">+ New metric</button>
        {dashboards.length > 0 && (
          <select value="" disabled={!!busy} onChange={(e) => e.target.value && suggest(e.target.value)} className="border border-rule bg-white px-2 py-1.5 text-[12px]">
            <option value="">✨ Suggest metrics from a dashboard’s data (3 credits)…</option>
            {dashboards.map((d) => (
              <option key={d.id} value={d.id}>{d.title}</option>
            ))}
          </select>
        )}
        {busy && <span className="animate-pulse text-[12px] text-mute">{busy}</span>}
      </div>
      {editing && <MetricForm initial={editing} dashboards={dashboards} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {sugg.length > 0 && (
        <div className="space-y-1.5 border border-dashed border-signal/60 bg-signal/[0.03] p-3">
          <div className="label">Suggested by Claude: review, then add</div>
          {sugg.map((m, k) => (
            <div key={k} className="flex items-start gap-2 bg-white px-3 py-2 text-[12.5px]">
              <div className="min-w-0 flex-1">
                <b>{m.name}</b> <span className="font-mono text-[11.5px] text-graphite">{m.expression}{m.filter ? ` WHERE ${m.filter}` : ""}</span>
                <div className="text-[11.5px] text-mute">{m.description}</div>
              </div>
              <button onClick={() => setEditing(m)} className="text-[11px] text-graphite hover:text-ink">Edit</button>
              <button onClick={() => accept(m)} className="border border-ink px-2 py-0.5 text-[11px] hover:bg-ink hover:text-paper">Add</button>
            </div>
          ))}
        </div>
      )}
      <div className="divide-y divide-rule border border-rule bg-white">
        {list.length === 0 && <p className="px-4 py-6 text-[13px] text-mute">No metrics yet. Add one, or let Claude suggest them from a dashboard’s data.</p>}
        {list.map((m) => (
          <div key={m.id} className="flex items-start gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium text-ink">
                {m.name}
                {m.aliases.length > 0 && <span className="ml-2 text-[11.5px] font-normal text-mute">also: {m.aliases.join(", ")}</span>}
              </div>
              <div className="font-mono text-[12px] text-graphite">
                {m.expression}
                {m.filter && <span className="text-mute"> WHERE {m.filter}</span>}
                <span className="ml-2 text-mute">[{m.format}{m.currency ? ` ${m.currency}` : ""}]</span>
              </div>
              {m.description && <div className="text-[12px] text-mute">{m.description}</div>}
            </div>
            <button onClick={() => setEditing(m)} className="text-[12px] text-graphite hover:text-ink">Edit</button>
            <button
              onClick={async () => {
                if (window.confirm(`Delete the metric “${m.name}”?`)) {
                  await del(`/api/metrics/${m.id}`);
                  load();
                }
              }}
              className="text-[12px] text-mute hover:text-signal"
            >
              Delete
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

type Report = Quality & { token: string; name: string; tables: Record<string, number>; log?: string[] };

function QualityTab() {
  const [rep, setRep] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const upload = async (f: File) => {
    setBusy(true);
    setErr("");
    try {
      const form = new FormData();
      form.append("file", f);
      setRep(await postForm<Report>("/api/quality/check", form));
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const fix = async (fx: Record<string, unknown>) => {
    if (!rep) return;
    setBusy(true);
    try {
      const r = await postJSON<Report>(`/api/quality/${rep.token}/fix`, fx);
      setRep({ ...rep, ...r });
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-[13px] leading-relaxed text-graphite">
        Check a CSV or Excel file before analysing it: duplicates, missing values, impossible values, outliers, inconsistent spellings, gaps in dates
        and codes that don’t match their lookup table. Fix with one click, then download the cleaned file. Files uploaded to Dashboards, Data chat
        and Analytics are checked automatically, and Claude is told about the issues.
      </p>
      <div className="flex items-center gap-2">
        <button onClick={() => input.current?.click()} disabled={busy} className="bg-ink px-3 py-1.5 text-[12px] font-medium text-paper hover:bg-signal disabled:opacity-40">
          {busy ? "Checking…" : "Upload a file to check"}
        </button>
        <input
          ref={input}
          type="file"
          hidden
          accept=".csv,.tsv,.txt,.xlsx,.xls,.xlsm"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void upload(f);
          }}
        />
        {rep && (
          <a href={`/api/quality/${rep.token}/download`} className="border border-ink px-3 py-1.5 text-[12px] hover:bg-ink hover:text-paper">
            Download cleaned file
          </a>
        )}
      </div>
      {err && <p className="text-[12px] text-signal">{err}</p>}
      {rep && (
        <div className="space-y-3">
          <div className="text-[12px] text-mute">
            {rep.name} · {Object.entries(rep.tables).map(([t, n]) => `${t} (${n.toLocaleString()} rows)`).join(" · ")}
          </div>
          {!!rep.log?.length && (
            <div className="border-l-2 border-[#107C10] bg-white px-3 py-2 text-[12px] text-graphite">
              {rep.log.map((l) => (
                <div key={l}>✓ {l}</div>
              ))}
            </div>
          )}
          <QualityReport q={rep} onFix={fix} busy={busy} />
        </div>
      )}
    </div>
  );
}

export function MetricsView() {
  const [tab, setTab] = useState<"metrics" | "quality">("metrics");
  return (
    <div className="h-full overflow-y-auto bg-sheet px-6 py-6 lg:px-10">
      <div className="mx-auto max-w-4xl">
        <h2 className="font-serif text-[28px] text-ink">Metrics &amp; data quality</h2>
        <div className="mb-5 mt-3 flex gap-5 border-b border-rule">
          {(["metrics", "quality"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cx("-mb-px border-b-2 py-2 text-[13px]", tab === t ? "border-ink font-medium text-ink" : "border-transparent text-graphite hover:text-ink")}
            >
              {t === "metrics" ? "Metric definitions" : "Data quality check"}
            </button>
          ))}
        </div>
        {tab === "metrics" ? <MetricsTab /> : <QualityTab />}
      </div>
    </div>
  );
}
