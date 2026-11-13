"use client";

// AutoML: load data → pick the column to predict → Ouroboros compares several algorithms, explains the
// winner in plain language and deploys it (scored by /api/predict and the "Try a prediction" form).

import { useCallback, useEffect, useRef, useState } from "react";
import { del, errorText, getJSON, postForm, postJSON } from "@/lib/api";
import { cx } from "@/components/ui";

interface Column { name: string; kind: string; unique: number; missing_pct: number; sample: string[] }
interface Dataset { id: string; label: string; rows: number; columns: Column[]; suggested_targets: string[]; truncated?: boolean }
interface Upload { file_id: string; name: string; tables: string[]; rows?: number }
interface BoardRow { name: string; baseline?: boolean; score: number; score_std: number; seconds: number; [k: string]: unknown }
interface Driver {
  feature: string; share: number; kind?: "number" | "category"; about?: string;
  low?: number; high?: number; at_low?: number; at_high?: number; direction?: string;
  highest?: string; lowest?: string; highest_value?: number; lowest_value?: number;
}
interface Field { name: string; kind: "number" | "category" | "date"; default: string | number; options?: string[]; min?: number; max?: number }
interface Job {
  id: string; dataset_label: string; target: string; task: string | null; status: "queued" | "running" | "completed" | "failed";
  stage: string; progress: { name: string; status: string; score?: number; seconds?: number; error?: string }[];
  leaderboard: BoardRow[]; best: BoardRow | null; metric?: string; holdout: Record<string, unknown> | null;
  drivers: Driver[]; warnings: string[]; dropped: Record<string, string>; model_file: string | null; model_ref?: string;
  explanation: { headline: string; summary: string; drivers: string[]; actions: string[]; caveats: string[]; source: string } | null;
  inputs?: Field[]; rows_used?: number; error: string; created_at: string;
}
interface JobRow { id: string; dataset_label: string; target: string; status: string; created_at: string; score?: number; algorithm?: string; metric?: string }

const field = "w-full border border-rule bg-white px-2 py-1.5 text-[13px] outline-none focus:border-ink";
const btn = "bg-ink px-4 py-1.5 text-[12px] font-medium text-paper hover:bg-signal disabled:opacity-40";
const ghost = "border border-ink px-3 py-1 text-[12px] hover:bg-ink hover:text-paper disabled:opacity-40";
const num = (v: unknown, d = 3) => (typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: d }) : "–");

export function AutoMLView() {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const loadJobs = useCallback(() => getJSON<JobRow[]>("/api/automl/jobs").then(setJobs).catch(() => {}), []);
  useEffect(() => { loadJobs(); }, [loadJobs]);

  return (
    <div className="grid h-full lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="border-b border-rule bg-paper p-4 lg:overflow-y-auto lg:border-b-0 lg:border-r">
        <button onClick={() => setOpenId(null)} className={cx(btn, "w-full")}>+ New model</button>
        <p className="mt-5 font-serif text-[13px] italic text-mute">Trained models</p>
        {!jobs.length && <p className="mt-2 text-[12px] text-graphite">None yet.</p>}
        <ul className="mt-2 space-y-1">
          {jobs.map((j) => (
            <li key={j.id}>
              <button onClick={() => setOpenId(j.id)}
                className={cx("w-full border-l-2 px-2 py-1.5 text-left text-[12.5px] hover:bg-sheet", openId === j.id ? "border-signal bg-sheet" : "border-transparent")}>
                <span className="block truncate font-medium text-ink">Predict {j.target}</span>
                <span className="block truncate text-[11px] text-graphite">
                  {j.dataset_label} · {j.status === "completed" ? `${j.algorithm} ${num(j.score)}` : j.status}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main className="min-w-0 overflow-y-auto bg-sheet px-6 py-6 lg:px-10">
        <div className="mx-auto max-w-4xl">
          {openId ? (
            <JobView key={openId} id={openId} onDeleted={() => { setOpenId(null); loadJobs(); }} onChange={loadJobs} />
          ) : (
            <NewModel onStarted={(id) => { setOpenId(id); loadJobs(); }} />
          )}
        </div>
      </main>
    </div>
  );
}

// ── Step 1 + 2: data, target, train ──────────────────────────────────────────

function NewModel({ onStarted }: { onStarted: (id: string) => void }) {
  const [src, setSrc] = useState<"file" | "upload" | "db">("file");
  const [file, setFile] = useState<File | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [uploadId, setUploadId] = useState("");
  const [uploadTable, setUploadTable] = useState("");
  const [db, setDb] = useState({ uri: "", schema: "", table: "" });
  const [ds, setDs] = useState<Dataset | null>(null);
  const [target, setTarget] = useState("");
  const [task, setTask] = useState("auto");
  const [exclude, setExclude] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => { getJSON<Upload[]>("/api/automl/uploads").then(setUploads).catch(() => {}); }, []);

  const load = async () => {
    setErr(""); setBusy("Reading the data…");
    const f = new FormData();
    if (src === "file" && file) f.append("file", file);
    if (src === "upload") { f.append("file_id", uploadId); f.append("table", uploadTable); }
    if (src === "db") { f.append("db_uri", db.uri); f.append("db_schema", db.schema); f.append("table", db.table); }
    try {
      const d = await postForm<Dataset>("/api/automl/datasets", f);
      setDs(d); setTarget(d.suggested_targets[0] || ""); setExclude([]);
    } catch (e) { setErr(errorText(e)); }
    setBusy("");
  };

  const train = async () => {
    if (!ds || !target) return;
    setErr(""); setBusy("Starting…");
    try {
      const j = await postJSON<Job>("/api/automl/jobs", { dataset_id: ds.id, target, task, exclude });
      onStarted(j.id);
    } catch (e) { setErr(errorText(e)); setBusy(""); }
  };

  const canLoad = (src === "file" && !!file) || (src === "upload" && !!uploadId) || (src === "db" && !!db.uri && !!db.table);
  const targetCol = ds?.columns.find((c) => c.name === target);

  return (
    <>
      <h2 className="font-serif text-[28px] text-ink">AutoML</h2>
      <p className="mt-1 max-w-2xl text-[13.5px] text-graphite">
        Pick a column to predict. Ouroboros trains and compares up to six algorithms, tests the winner on rows it has never
        seen, explains what drives the prediction and deploys it so you can score new data.
      </p>

      <section className="mt-6 border border-rule bg-white p-5">
        <h3 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-ink">1 · Data</h3>
        <div className="mt-3 flex gap-5 border-b border-rule">
          {([["file", "Upload a file"], ["upload", "An uploaded file"], ["db", "A database table"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setSrc(k)}
              className={cx("-mb-px border-b-2 py-2 text-[13px]", src === k ? "border-ink font-medium text-ink" : "border-transparent text-graphite hover:text-ink")}>
              {l}
            </button>
          ))}
        </div>
        <div className="mt-4 space-y-2">
          {src === "file" && (
            <input type="file" accept=".csv,.tsv,.txt,.xlsx,.xlsm,.xls,.parquet,.feather,.json,.jsonl"
              onChange={(e) => setFile(e.target.files?.[0] || null)} className="text-[13px]" />
          )}
          {src === "upload" && (uploads.length ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <select className={field} value={uploadId} onChange={(e) => { setUploadId(e.target.value); setUploadTable(""); }}>
                <option value="">Choose a file…</option>
                {uploads.map((u) => <option key={u.file_id} value={u.file_id}>{u.name}</option>)}
              </select>
              {(uploads.find((u) => u.file_id === uploadId)?.tables.length || 0) > 1 && (
                <select className={field} value={uploadTable} onChange={(e) => setUploadTable(e.target.value)}>
                  <option value="">Main sheet</option>
                  {uploads.find((u) => u.file_id === uploadId)!.tables.map((t) => <option key={t}>{t}</option>)}
                </select>
              )}
            </div>
          ) : <p className="text-[12.5px] text-graphite">No files uploaded in this session yet. Upload one in Analytics, or use “Upload a file”.</p>)}
          {src === "db" && (
            <>
              <input className={cx(field, "font-mono")} placeholder="Connection string, e.g. postgresql://user:pass@host:5432/db"
                value={db.uri} onChange={(e) => setDb({ ...db, uri: e.target.value })} />
              <div className="grid gap-2 sm:grid-cols-2">
                <input className={field} placeholder="Schema (optional)" value={db.schema} onChange={(e) => setDb({ ...db, schema: e.target.value })} />
                <input className={field} placeholder="Table" value={db.table} onChange={(e) => setDb({ ...db, table: e.target.value })} />
              </div>
              <p className="text-[11.5px] text-mute">Read-only: one validated SELECT in a read-only transaction. Nothing in your database is changed.</p>
            </>
          )}
          <button onClick={load} disabled={!canLoad || !!busy} className={btn}>{busy && !ds ? busy : "Load data"}</button>
        </div>
      </section>

      {ds && (
        <section className="mt-5 border border-rule bg-white p-5">
          <h3 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-ink">2 · What to predict</h3>
          <p className="mt-1 text-[12.5px] text-graphite">
            {ds.label} · {ds.rows.toLocaleString()} rows · {ds.columns.length} columns{ds.truncated ? " (first 200,000 rows)" : ""}
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_220px]">
            <label className="text-[12px] text-graphite">Column to predict
              <select className={cx(field, "mt-1")} value={target} onChange={(e) => { setTarget(e.target.value); setExclude((x) => x.filter((c) => c !== e.target.value)); }}>
                {ds.suggested_targets.length > 0 && (
                  <optgroup label="Suggested">{ds.suggested_targets.map((c) => <option key={c}>{c}</option>)}</optgroup>
                )}
                <optgroup label="All columns">{ds.columns.map((c) => <option key={c.name}>{c.name}</option>)}</optgroup>
              </select>
            </label>
            <label className="text-[12px] text-graphite">Kind of prediction
              <select className={cx(field, "mt-1")} value={task} onChange={(e) => setTask(e.target.value)}>
                <option value="auto">Decide for me</option>
                <option value="classification">A category (yes/no, segment…)</option>
                <option value="regression">A number (amount, price…)</option>
              </select>
            </label>
          </div>
          {targetCol && (
            <p className="mt-2 text-[12px] text-graphite">
              {targetCol.unique} different values{targetCol.sample.length ? `, e.g. ${targetCol.sample.slice(0, 3).join(", ")}` : ""}
              {targetCol.missing_pct ? ` · ${targetCol.missing_pct}% empty (those rows are skipped)` : ""}
            </p>
          )}
          <p className="mt-4 text-[12px] text-graphite">
            Leave out columns that are only known <em>after</em> the outcome (they make the model look better than it is):
          </p>
          <div className="mt-2 max-h-56 overflow-y-auto border border-rule">
            <table className="w-full text-[12.5px]">
              <tbody>
                {ds.columns.filter((c) => c.name !== target).map((c) => (
                  <tr key={c.name} className="border-b border-rule last:border-0">
                    <td className="w-8 px-2 py-1"><input type="checkbox" checked={exclude.includes(c.name)}
                      onChange={(e) => setExclude((x) => e.target.checked ? [...x, c.name] : x.filter((n) => n !== c.name))} aria-label={`Leave out ${c.name}`} /></td>
                    <td className="px-2 py-1 font-medium text-ink">{c.name}</td>
                    <td className="px-2 py-1 text-graphite">{c.kind}</td>
                    <td className="px-2 py-1 text-right font-mono text-[11px] text-mute">{c.unique.toLocaleString()} values{c.missing_pct ? ` · ${c.missing_pct}% empty` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button onClick={train} disabled={!target || !!busy} className={btn}>Train models · 30 credits</button>
            <span className="text-[11.5px] text-mute">Refunded if training fails. Takes about a minute.</span>
          </div>
        </section>
      )}
      {err && <p className="mt-4 border-l-2 border-signal bg-white px-3 py-2 text-[13px] text-ink">{err}</p>}
    </>
  );
}

// ── Job: progress, leaderboard, explanation, drivers, try a prediction ───────

function JobView({ id, onDeleted, onChange }: { id: string; onDeleted: () => void; onChange: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const j = await getJSON<Job>(`/api/automl/jobs/${id}`);
        if (!alive) return;
        setJob(j);
        if (j.status === "queued" || j.status === "running") timer.current = setTimeout(tick, 1500);
        else onChange();
      } catch (e) { if (alive) setErr(errorText(e)); }
    };
    tick();
    return () => { alive = false; clearTimeout(timer.current); };
  }, [id, onChange]);

  if (err) return <p className="text-[13px] text-ink">{err}</p>;
  if (!job) return <p className="font-serif text-[18px] italic text-graphite">Loading…</p>;
  const live = job.status === "queued" || job.status === "running";
  const ho = job.holdout || {};

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-serif text-[28px] text-ink">Predict {job.target}</h2>
          <p className="text-[12.5px] text-graphite">{job.dataset_label}{job.rows_used ? ` · ${job.rows_used.toLocaleString()} rows` : ""}{job.task ? ` · ${job.task}` : ""}</p>
        </div>
        {!live && (
          <button className={ghost} onClick={async () => { if (confirm("Delete this model? Its deployed file is removed too.")) { await del(`/api/automl/jobs/${id}`); onDeleted(); } }}>Delete</button>
        )}
      </div>

      {live && (
        <section className="mt-5 border border-rule bg-white p-5">
          <p className="animate-pulse font-serif text-[18px] italic text-graphite">{job.stage}</p>
          <ul className="mt-3 space-y-1 text-[12.5px]">
            {job.progress.map((p) => (
              <li key={p.name} className="flex justify-between gap-3">
                <span className={cx(p.status === "training" ? "font-medium text-ink" : "text-graphite")}>{p.name}</span>
                <span className="font-mono text-[11.5px] text-mute">{p.status === "done" ? `${num(p.score)} · ${p.seconds}s` : p.status}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {job.status === "failed" && <p className="mt-5 border-l-2 border-signal bg-white px-3 py-2 text-[13px] text-ink">{job.error}</p>}

      {job.status === "completed" && job.best && (
        <>
          {job.explanation && (
            <section className="mt-5 border border-ink bg-white p-5">
              <p className="font-serif text-[20px] leading-snug text-ink">{job.explanation.headline}</p>
              <p className="mt-2 text-[13.5px] text-graphite">{job.explanation.summary}</p>
              {job.explanation.actions.length > 0 && (
                <>
                  <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink">What to do with it</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-[13px] text-ink">{job.explanation.actions.map((a) => <li key={a}>{a}</li>)}</ul>
                </>
              )}
            </section>
          )}

          {job.warnings.length > 0 && (
            <section className="mt-4 space-y-2">
              {job.warnings.map((w) => <p key={w} className="border-l-2 border-signal bg-white px-3 py-2 text-[12.5px] text-ink">⚠ {w}</p>)}
            </section>
          )}

          <section className="mt-5 grid gap-5 lg:grid-cols-2">
            <div className="border border-rule bg-white p-5">
              <h3 className="text-[13px] font-semibold text-ink">Leaderboard</h3>
              <p className="text-[11.5px] text-mute">{job.metric} in cross-validation (higher is better)</p>
              <ul className="mt-3 space-y-2">
                {job.leaderboard.map((r, i) => {
                  const w = Math.max(0, Math.min(1, r.score)) * 100;
                  return (
                    <li key={r.name}>
                      <div className="flex justify-between text-[12.5px]">
                        <span className={cx(i === 0 && !r.baseline ? "font-semibold text-ink" : r.baseline ? "italic text-mute" : "text-graphite")}>
                          {i === 0 && !r.baseline ? "★ " : ""}{r.name}
                        </span>
                        <span className="font-mono text-[11.5px]">{num(r.score)} <span className="text-mute">±{num(r.score_std, 2)}</span></span>
                      </div>
                      <div className="mt-1 h-1.5 bg-sheet"><div className={cx("h-full", r.baseline ? "bg-rule" : i === 0 ? "bg-signal" : "bg-ink/50")} style={{ width: `${w}%` }} /></div>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="border border-rule bg-white p-5">
              <h3 className="text-[13px] font-semibold text-ink">On {num(ho.rows, 0)} rows it never saw</h3>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-[12.5px]">
                {(["accuracy", "f1_macro", "roc_auc", "r2", "mae", "rmse"] as const).filter((k) => typeof ho[k] === "number").map((k) => (
                  <div key={k}><dt className="text-mute">{{ accuracy: "Accuracy", f1_macro: "F1 (macro)", roc_auc: "ROC AUC", r2: "R²", mae: "Avg. error (MAE)", rmse: "RMSE" }[k]}</dt>
                    <dd className="font-mono text-[15px] text-ink">{k === "accuracy" ? `${((ho[k] as number) * 100).toFixed(1)}%` : num(ho[k])}</dd></div>
                ))}
              </dl>
              {Array.isArray(ho.per_class) && (
                <table className="mt-4 w-full text-[12px]">
                  <thead><tr className="text-left text-mute"><th className="font-normal">Class</th><th className="text-right font-normal">Found (recall)</th><th className="text-right font-normal">Right when it says so</th></tr></thead>
                  <tbody>
                    {(ho.per_class as { label: string; recall: number; precision: number; support: number }[]).map((c) => (
                      <tr key={c.label} className="border-t border-rule"><td className="py-1">{c.label} <span className="text-mute">({c.support})</span></td>
                        <td className="text-right font-mono">{(c.recall * 100).toFixed(0)}%</td><td className="text-right font-mono">{(c.precision * 100).toFixed(0)}%</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          <section className="mt-5 border border-rule bg-white p-5">
            <h3 className="text-[13px] font-semibold text-ink">What drives the prediction</h3>
            {job.drivers[0]?.about && <p className="text-[11.5px] text-mute">Effects shown on the {job.drivers[0].about}</p>}
            <ul className="mt-3 space-y-3">
              {job.drivers.slice(0, 8).map((d, i) => (
                <li key={d.feature}>
                  <div className="flex items-center gap-3">
                    <span className="w-44 shrink-0 truncate text-[12.5px] font-medium text-ink" title={d.feature}>{d.feature}</span>
                    <div className="h-2 flex-1 bg-sheet"><div className="h-full bg-ink" style={{ width: `${Math.round(d.share * 100)}%` }} /></div>
                    <span className="w-10 text-right font-mono text-[11px] text-mute">{Math.round(d.share * 100)}%</span>
                  </div>
                  <p className="mt-0.5 pl-[11.75rem] text-[12px] text-graphite">
                    {job.explanation?.drivers[i] ||
                      (d.kind === "number" ? `From ${num(d.low)} to ${num(d.high)}: ${num(d.at_low)} → ${num(d.at_high)}` :
                        d.kind === "category" ? `Highest for “${d.highest}”, lowest for “${d.lowest}”` : "")}
                  </p>
                </li>
              ))}
            </ul>
            {job.explanation && job.explanation.caveats.length > 0 && (
              <p className="mt-4 text-[11.5px] text-mute">{job.explanation.caveats.join(" ")}</p>
            )}
            {Object.keys(job.dropped).length > 0 && (
              <p className="mt-3 text-[11.5px] text-mute">Not used: {Object.entries(job.dropped).map(([c, why]) => `${c} (${why})`).join(" · ")}</p>
            )}
          </section>

          {job.inputs && job.inputs.length > 0 && <TryIt job={job} />}

          <p className="mt-5 text-[11.5px] text-mute">
            Deployed as <span className="font-mono">{job.model_ref}</span>: score a whole file in Analytics → Model lab, or POST it to
            <span className="font-mono"> /api/predict</span>.
          </p>
        </>
      )}
    </>
  );
}

function TryIt({ job }: { job: Job }) {
  const [row, setRow] = useState<Record<string, string | number>>(() => Object.fromEntries((job.inputs || []).map((f) => [f.name, f.default])));
  const [res, setRes] = useState<{ prediction: string | number; probabilities?: Record<string, number> } | null>(null);
  const [err, setErr] = useState("");
  const run = async () => {
    setErr("");
    try { setRes(await postJSON(`/api/automl/jobs/${job.id}/predict`, { row })); } catch (e) { setErr(errorText(e)); }
  };
  return (
    <section className="mt-5 border border-rule bg-white p-5">
      <h3 className="text-[13px] font-semibold text-ink">Try a prediction</h3>
      <p className="text-[11.5px] text-mute">Change any value and predict. Free – no AI is involved.</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {(job.inputs || []).map((f) => (
          <label key={f.name} className="text-[11.5px] text-graphite">{f.name}
            {f.kind === "category" ? (
              <select className={cx(field, "mt-0.5")} value={String(row[f.name])} onChange={(e) => setRow({ ...row, [f.name]: e.target.value })}>
                {(f.options || []).map((o) => <option key={o}>{o}</option>)}
              </select>
            ) : (
              <input className={cx(field, "mt-0.5")} type={f.kind === "date" ? "date" : "number"} value={String(row[f.name] ?? "")}
                min={f.min ?? undefined} max={f.max ?? undefined}
                onChange={(e) => setRow({ ...row, [f.name]: f.kind === "number" ? Number(e.target.value) : e.target.value })} />
            )}
          </label>
        ))}
      </div>
      <button onClick={run} className={cx(btn, "mt-4")}>Predict</button>
      {err && <p className="mt-3 text-[12.5px] text-ink">{err}</p>}
      {res && (
        <div className="mt-4 border-t border-rule pt-3">
          <p className="text-[13px] text-graphite">{job.target}: <span className="font-serif text-[22px] text-ink">{typeof res.prediction === "number" ? num(res.prediction, 2) : res.prediction}</span></p>
          {res.probabilities && (
            <ul className="mt-2 space-y-1">
              {Object.entries(res.probabilities).sort((a, b) => b[1] - a[1]).map(([c, p]) => (
                <li key={c} className="flex items-center gap-3 text-[12px]">
                  <span className="w-32 truncate">{c}</span>
                  <div className="h-1.5 flex-1 bg-sheet"><div className="h-full bg-signal" style={{ width: `${p * 100}%` }} /></div>
                  <span className="w-12 text-right font-mono">{(p * 100).toFixed(1)}%</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
