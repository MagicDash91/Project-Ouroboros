"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { del, errorText, getJSON, postForm, postJSON } from "@/lib/api";
import type { Finding, ModelInfo, Monitor } from "@/lib/types";
import { Refresh } from "../icons";
import { Button, Card, DataTable, Empty, ErrorNote, Field, SectionHead, Working, cx } from "../ui";

const Page = ({ children }: { children: ReactNode }) => (
  <div className="mx-auto max-w-[1080px] px-6 py-10 lg:px-10">{children}</div>
);

/** One numbered tool block: number and title on the left, controls on the right. */
function Tool({ n, title, blurb, children }: { n: string; title: string; blurb: string; children: ReactNode }) {
  return (
    <section className="grid gap-6 border-t border-ink py-8 first-of-type:border-t-0 first-of-type:pt-0 lg:grid-cols-[260px_minmax(0,1fr)]">
      <div>
        <div className="font-mono text-[12px] text-signal">{n}</div>
        <h3 className="mt-1 font-serif text-[1.35rem] font-medium leading-tight">{title}</h3>
        <p className="mt-2 text-[12.5px] leading-relaxed text-mute">{blurb}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function useAsync<T>() {
  const [state, setState] = useState<{ loading: boolean; error: string | null; data: T | null }>({
    loading: false,
    error: null,
    data: null,
  });
  const run = useCallback(async (fn: () => Promise<T>) => {
    setState({ loading: true, error: null, data: null });
    try {
      setState({ loading: false, error: null, data: await fn() });
    } catch (e) {
      setState({ loading: false, error: errorText(e), data: null });
    }
  }, []);
  return { ...state, run };
}

function ModelSelect({ models, value, onChange }: { models: ModelInfo[]; value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="field">
      {models.length === 0 && <option value="">No trained models yet</option>}
      {models.map((m) => (
        <option key={m.filename} value={m.filename}>
          {m.model_type || m.filename} · {(m.created || "").slice(0, 16).replace("T", " ")}
        </option>
      ))}
    </select>
  );
}

/** Accepts JSON, or one `key = value` per line (numbers are parsed). */
function parseOverrides(text: string): Record<string, unknown> {
  const t = text.trim();
  if (!t) return {};
  if (t.startsWith("{")) return JSON.parse(t);
  const out: Record<string, unknown> = {};
  for (const line of t.split(/\n|,/)) {
    if (!line.trim()) continue;
    const m = line.match(/^\s*([^=:]+?)\s*[=:]\s*(.+?)\s*$/);
    if (!m) throw new Error(`Can't read "${line.trim()}". Use key = value.`);
    const raw = m[2].replace(/^["']|["']$/g, "");
    out[m[1]] = raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
  }
  return out;
}

interface PredictResult {
  summary: { rows_scored: number; prediction_distribution: Record<string, number>; mean_probability?: number; high_risk_count?: number };
  download_url: string;
  preview: Record<string, unknown>[];
}
interface DriversResult {
  method: string;
  drivers: { feature: string; importance: number; direction: string }[];
  narrative?: string;
}
interface WhatIfResult {
  baseline_probability: number;
  scenario_probability: number;
  probability_delta?: number;
  narrative?: string;
}
interface ExploreResult {
  sql: string;
  summary?: string;
  rows: Record<string, unknown>[];
}

const pct = (p?: number) => (p == null ? "–" : `${(p * 100).toFixed(1)}%`);

/* ── Model lab ───────────────────────────────────────────────────────── */
export function ModelLabView() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [predModel, setPredModel] = useState("");
  const [drvModel, setDrvModel] = useState("");
  const [wiModel, setWiModel] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [overrides, setOverrides] = useState("");
  const [question, setQuestion] = useState("");
  const predict = useAsync<PredictResult>();
  const drivers = useAsync<DriversResult>();
  const whatif = useAsync<WhatIfResult>();
  const explore = useAsync<ExploreResult>();

  const loadModels = useCallback(() => {
    getJSON<{ models: ModelInfo[] }>("/api/models")
      .then((r) => {
        const ms = r.models || [];
        setModels(ms);
        const first = ms[0]?.filename || "";
        setPredModel((v) => v || first);
        setDrvModel((v) => v || first);
        setWiModel((v) => v || first);
      })
      .catch(() => setModels([]));
  }, []);
  useEffect(() => {
    loadModels();
  }, [loadModels]);

  const maxImportance = Math.max(...(drivers.data?.drivers || []).map((d) => Math.abs(d.importance)), 0) || 1;

  return (
    <Page>
      <SectionHead
        kicker="Tools"
        title="Model lab"
        aside={
          <Button size="sm" tone="quiet" onClick={loadModels}>
            <Refresh size={13} /> {models.length} model{models.length === 1 ? "" : "s"}
          </Button>
        }
      />

      <Tool n="01" title="Score new data" blurb="Run a trained model over a fresh CSV or Excel file and download the scored rows.">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
          <Field label="Model">
            <ModelSelect models={models} value={predModel} onChange={setPredModel} />
          </Field>
          <Field label="File">
            <input type="file" accept=".csv,.xlsx,.xls" onChange={(e) => setFile(e.target.files?.[0] || null)} className="field py-[5px] text-[12px] file:mr-3 file:border-0 file:bg-ink file:px-2 file:py-1 file:text-[11px] file:text-paper" />
          </Field>
          <Button
            tone="ink"
            disabled={!predModel || !file || predict.loading}
            onClick={() => {
              const form = new FormData();
              form.append("file", file!);
              predict.run(() => postForm<PredictResult>(`/api/predict?model_ref=${encodeURIComponent(predModel)}`, form));
            }}
          >
            Score
          </Button>
        </div>
        <div className="mt-4">
          {predict.loading && <Working label="Scoring" />}
          {predict.error && <ErrorNote>{predict.error}</ErrorNote>}
          {predict.data && (
            <div className="rise">
              <dl className="grid grid-cols-2 gap-px border border-rule bg-rule sm:grid-cols-4">
                {[
                  ["Rows scored", predict.data.summary.rows_scored?.toLocaleString()],
                  ["Mean probability", pct(predict.data.summary.mean_probability)],
                  ["High risk (≥ 50%)", predict.data.summary.high_risk_count?.toLocaleString() ?? "–"],
                  [
                    "Predictions",
                    Object.entries(predict.data.summary.prediction_distribution || {})
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(" · "),
                  ],
                ].map(([k, v]) => (
                  <div key={k} className="bg-sheet px-4 py-3">
                    <dt className="label">{k}</dt>
                    <dd className="mt-1 font-mono text-[15px]">{v || "–"}</dd>
                  </div>
                ))}
              </dl>
              <a href={predict.data.download_url} className="mt-3 inline-block text-[12.5px] font-medium underline underline-offset-4 hover:text-signal">
                Download the scored file
              </a>
              <DataTable rows={predict.data.preview} maxCols={8} maxRows={10} />
            </div>
          )}
        </div>
      </Tool>

      <Tool n="02" title="Key drivers" blurb="Which features move the model's predictions most, using SHAP where available.">
        <div className="flex gap-3">
          <div className="flex-1">
            <ModelSelect models={models} value={drvModel} onChange={setDrvModel} />
          </div>
          <Button tone="ink" disabled={!drvModel || drivers.loading} onClick={() => drivers.run(() => postJSON<DriversResult>("/api/analyze/drivers", { model_ref: drvModel }))}>
            Analyze
          </Button>
        </div>
        <div className="mt-4">
          {drivers.loading && <Working label="Computing drivers" />}
          {drivers.error && <ErrorNote>{drivers.error}</ErrorNote>}
          {drivers.data && (
            <div className="rise">
              <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.08em] text-mute">Method · {drivers.data.method}</p>
              <ul className="space-y-2">
                {drivers.data.drivers.map((d) => (
                  <li key={d.feature} className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)_90px] items-center gap-3 text-[13px]">
                    <span className="truncate" title={d.feature}>
                      {d.feature}
                    </span>
                    <span className="h-2 bg-rule">
                      <span
                        className={cx("block h-full", d.direction === "increases" ? "bg-signal" : d.direction === "decreases" ? "bg-moss" : "bg-graphite")}
                        style={{ width: `${(Math.abs(d.importance) / maxImportance) * 100}%` }}
                      />
                    </span>
                    <span className="text-right font-mono text-[11.5px] text-mute">{d.direction}</span>
                  </li>
                ))}
              </ul>
              {drivers.data.narrative && <p className="mt-4 max-w-[62ch] font-serif text-[15.5px] leading-relaxed">{drivers.data.narrative}</p>}
            </div>
          )}
        </div>
      </Tool>

      <Tool n="03" title="What-if" blurb="Change a few inputs on a typical record and see how the predicted probability moves.">
        <div className="space-y-3">
          <ModelSelect models={models} value={wiModel} onChange={setWiModel} />
          <Field label="Changes" hint="One per line, e.g. tenure = 2. JSON works too.">
            <textarea value={overrides} onChange={(e) => setOverrides(e.target.value)} rows={3} className="field font-mono text-[12px]" placeholder={"tenure = 2\nMonthlyCharges = 115"} spellCheck={false} />
          </Field>
          <Button
            tone="ink"
            disabled={!wiModel || whatif.loading}
            onClick={() => whatif.run(async () => postJSON<WhatIfResult>("/api/analyze/whatif", { model_ref: wiModel, overrides: parseOverrides(overrides) }))}
          >
            Simulate
          </Button>
        </div>
        <div className="mt-4">
          {whatif.loading && <Working label="Simulating" />}
          {whatif.error && <ErrorNote>{whatif.error}</ErrorNote>}
          {whatif.data && (
            <div className="rise">
              <div className="flex items-baseline gap-4 font-serif">
                <span className="text-[2rem] text-mute">{pct(whatif.data.baseline_probability)}</span>
                <span className="text-mute">→</span>
                <span className="text-[2.6rem] font-medium">{pct(whatif.data.scenario_probability)}</span>
                {whatif.data.probability_delta != null && (
                  <span className={cx("font-mono text-[14px]", whatif.data.probability_delta > 0 ? "text-signal" : "text-moss")}>
                    {whatif.data.probability_delta > 0 ? "+" : ""}
                    {(whatif.data.probability_delta * 100).toFixed(1)} pts
                  </span>
                )}
              </div>
              {whatif.data.narrative && <p className="mt-3 max-w-[62ch] text-[13.5px] leading-relaxed text-graphite">{whatif.data.narrative}</p>}
            </div>
          )}
        </div>
      </Tool>

      <Tool n="04" title="Ask your data" blurb="A plain-English question becomes SQL against the active database. The query is shown so you can check it.">
        <form
          className="flex gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (question.trim()) explore.run(() => postJSON<ExploreResult>("/api/explore", { question: question.trim() }));
          }}
        >
          <input value={question} onChange={(e) => setQuestion(e.target.value)} className="field" placeholder="Average monthly charges by contract type" />
          <Button tone="ink" type="submit" disabled={!question.trim() || explore.loading}>
            Ask
          </Button>
        </form>
        <div className="mt-4">
          {explore.loading && <Working label="Writing the query" />}
          {explore.error && <ErrorNote>{explore.error}</ErrorNote>}
          {explore.data && (
            <div className="rise">
              <pre className="overflow-x-auto bg-night px-4 py-3 font-mono text-[12px] leading-relaxed text-paper/85">{explore.data.sql}</pre>
              {explore.data.summary && <p className="mt-3 max-w-[62ch] font-serif text-[15.5px] leading-relaxed">{explore.data.summary}</p>}
              <DataTable rows={explore.data.rows} />
            </div>
          )}
        </div>
      </Tool>
    </Page>
  );
}

/* ── Monitoring ──────────────────────────────────────────────────────── */
interface RunResult {
  status: string;
  findings?: Finding[];
  narrative?: string;
}
interface Alert {
  checked_at: string;
  status: string;
  findings?: Finding[];
}

function MonitorRow({ m, onChanged }: { m: Monitor; onChanged: () => void }) {
  const [busy, setBusy] = useState<"run" | "alerts" | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(kind: "run" | "alerts") {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "run") {
        setAlerts(null);
        setResult(await postJSON<RunResult>(`/api/monitors/${m.id}/run`));
        onChanged();
      } else {
        setResult(null);
        setAlerts((await getJSON<{ alerts: Alert[] }>(`/api/monitors/${m.id}/alerts`)).alerts || []);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const drift = (s?: string) => s === "drift_detected";

  return (
    <li className="border-b border-rule py-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-baseline gap-3">
            <span className="font-serif text-[1.25rem]">{m.name || m.table}</span>
            <span className={cx("font-mono text-[11px] uppercase", drift(m.last_status) ? "text-signal" : "text-mute")}>
              {(m.last_status || "not run").replace(/_/g, " ")}
            </span>
          </div>
          <p className="mt-1 font-mono text-[11.5px] text-mute">
            {m.table} · every {m.interval_minutes} min · last run {m.last_run ? new Date(m.last_run).toLocaleString() : "never"}
          </p>
        </div>
        <div className="flex gap-1">
          <Button size="sm" tone="line" disabled={!!busy} onClick={() => act("run")}>
            Run now
          </Button>
          <Button size="sm" tone="quiet" disabled={!!busy} onClick={() => act("alerts")}>
            Alerts · {m.alert_count || 0}
          </Button>
          <Button
            size="sm"
            tone="quiet"
            className="text-signal hover:text-signal"
            onClick={async () => {
              if (!confirm(`Delete the monitor "${m.name || m.table}"?`)) return;
              await del(`/api/monitors/${m.id}`).catch((e) => setError(errorText(e)));
              onChanged();
            }}
          >
            Delete
          </Button>
        </div>
      </div>
      <div className="mt-3 empty:hidden">
        {busy && <Working label={busy === "run" ? "Checking" : "Loading alerts"} />}
        {error && <ErrorNote>{error}</ErrorNote>}
        {result && (
          <div className={cx("rise border-l-2 pl-4", drift(result.status) ? "border-signal" : "border-moss")}>
            <p className={cx("text-[13px] font-medium", drift(result.status) ? "text-signal" : "text-moss")}>{result.status.replace(/_/g, " ")}</p>
            <ul className="mt-1 space-y-0.5 text-[13px] text-graphite">
              {result.findings?.map((f, i) => <li key={i}>{f.detail}</li>)}
            </ul>
            {result.narrative && <p className="mt-2 max-w-[62ch] text-[13px] italic text-mute">{result.narrative}</p>}
          </div>
        )}
        {alerts &&
          (alerts.length === 0 ? (
            <p className="text-[13px] italic text-mute">No alerts on record.</p>
          ) : (
            <ol className="rise space-y-3 border-l border-rule pl-4">
              {alerts.map((a, i) => (
                <li key={i} className="text-[13px]">
                  <span className="font-mono text-[11.5px] text-mute">{new Date(a.checked_at).toLocaleString()}</span>
                  <span className={cx("ml-2", drift(a.status) && "text-signal")}>{a.status.replace(/_/g, " ")}</span>
                  {a.findings?.map((f, j) => (
                    <div key={j} className="text-graphite">
                      {f.detail}
                    </div>
                  ))}
                </li>
              ))}
            </ol>
          ))}
      </div>
    </li>
  );
}

export function MonitorView() {
  const [monitors, setMonitors] = useState<Monitor[] | null>(null);
  const [form, setForm] = useState({ name: "", table: "", db_uri: "", target_column: "", interval_minutes: "60", webhook_url: "" });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    getJSON<{ monitors: Monitor[] }>("/api/monitors")
      .then((r) => setMonitors(r.monitors || []))
      .catch((e) => {
        setMonitors([]);
        setError(errorText(e));
      });
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await postJSON("/api/monitors", {
        ...form,
        interval_minutes: parseInt(form.interval_minutes || "60", 10),
        metric_columns: [],
      });
      setForm((f) => ({ ...f, name: "", table: "" }));
      load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Page>
      <SectionHead kicker="Tools" title="Monitoring" />
      <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div>
          <div className="label mb-1">Watching</div>
          {monitors === null ? (
            <Working label="Loading monitors" />
          ) : monitors.length === 0 ? (
            <Empty title="Nothing is being watched.">Create a monitor to check a table on a schedule for drift and anomalies.</Empty>
          ) : (
            <ul className="border-t border-ink">
              {monitors.map((m) => (
                <MonitorRow key={m.id} m={m} onChanged={load} />
              ))}
            </ul>
          )}
        </div>

        <Card className="self-start p-5">
          <form onSubmit={create} className="space-y-3">
            <div className="font-serif text-[1.2rem]">New monitor</div>
            <Field label="Table *">
              <input required className="field" value={form.table} onChange={set("table")} placeholder="transactions" />
            </Field>
            <Field label="Name">
              <input className="field" value={form.name} onChange={set("name")} placeholder="Transaction drift" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Target column">
                <input className="field" value={form.target_column} onChange={set("target_column")} placeholder="Churn" />
              </Field>
              <Field label="Every (min)">
                <input className="field font-mono" type="number" min={1} value={form.interval_minutes} onChange={set("interval_minutes")} />
              </Field>
            </div>
            <Field label="Database URI" hint="Defaults to the active database">
              <input className="field font-mono text-[12px]" value={form.db_uri} onChange={set("db_uri")} spellCheck={false} />
            </Field>
            <Field label="Webhook URL" hint="Optional. Alerts are POSTed here.">
              <input className="field font-mono text-[12px]" value={form.webhook_url} onChange={set("webhook_url")} placeholder="https://" spellCheck={false} />
            </Field>
            {error && <ErrorNote>{error}</ErrorNote>}
            <Button tone="ink" type="submit" className="w-full" disabled={creating || !form.table.trim()}>
              {creating ? "Creating" : "Create monitor"}
            </Button>
          </form>
        </Card>
      </div>
    </Page>
  );
}

/* ── Document Q&A ────────────────────────────────────────────────────── */
interface RagResult {
  answer: string;
  citations?: { n: number; source: string; snippet: string }[];
}

export function DocsView({ taskId }: { taskId: string | null }) {
  const [q, setQ] = useState("");
  const ask = useAsync<RagResult>();

  return (
    <Page>
      <SectionHead kicker="Tools" title="Document Q&A" />
      <p className="mb-6 max-w-[62ch] text-[13.5px] leading-relaxed text-graphite">
        Ask about the PDFs, Word files and decks attached to the latest run. Every answer cites the passage it came from.
      </p>
      <form
        className="flex gap-3 border-b border-ink pb-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim() && taskId) ask.run(() => postJSON<RagResult>("/api/rag/query", { question: q.trim(), task_id: taskId }));
        }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="What were the key risks mentioned in the report?"
          className="flex-1 border-0 border-b border-rule bg-transparent py-2 font-serif text-[1.15rem] placeholder:italic placeholder:text-mute focus:border-ink focus:outline-none"
        />
        <Button tone="ink" type="submit" disabled={!q.trim() || !taskId || ask.loading}>
          Ask
        </Button>
      </form>
      {!taskId && <p className="mt-4 text-[13px] italic text-mute">Run the pipeline with documents attached first.</p>}

      <div className="mt-8">
        {ask.loading && <Working label="Reading the documents" />}
        {ask.error && <ErrorNote>{ask.error}</ErrorNote>}
        {ask.data && (
          <div className="rise grid gap-10 lg:grid-cols-[minmax(0,1fr)_300px]">
            <p className="max-w-[62ch] whitespace-pre-wrap font-serif text-[17px] leading-relaxed">{ask.data.answer}</p>
            {ask.data.citations && ask.data.citations.length > 0 && (
              <aside>
                <div className="label mb-3">Sources</div>
                <ol className="space-y-4">
                  {ask.data.citations.map((c) => (
                    <li key={c.n} className="border-l-2 border-signal pl-3 text-[12.5px]">
                      <div className="font-mono text-[11px] text-signal">
                        [{c.n}] {c.source}
                      </div>
                      <p className="mt-1 italic leading-relaxed text-graphite">“{c.snippet}…”</p>
                    </li>
                  ))}
                </ol>
              </aside>
            )}
          </div>
        )}
      </div>
    </Page>
  );
}
