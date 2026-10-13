"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { del, errorText, formatBytes, getJSON, postForm, postJSON } from "@/lib/api";
import type {
  DataChatDataset,
  DataChatMessage,
  DataChatSession,
  DataChatStep,
  DataChatSummary,
  DataChatTable,
  DataChatOverview,
  DataChatPin,
  DbTestResult,
  ImportedFile,
} from "@/lib/types";
import { onIntent } from "@/lib/intent";
import { Followups, GlossaryPanel, OverviewCard } from "../datachat/Extras";
import { OpenStudio } from "../studio/OpenStudio";
import { ShareButton } from "../studio/ShareDialog";
import { AppConnectors } from "../AppConnectors";
import { ChevronDown, ChevronRight, Send, Upload, X } from "../icons";
import { Markdown } from "../Markdown";
import { useLightbox } from "../Overlays";
import { Button, ErrorNote, Field, Working, cx } from "../ui";

const ACCEPT = ".csv,.tsv,.txt,.xlsx,.xlsm,.xls,.parquet,.pq,.feather,.json,.jsonl,.ndjson";
const FORMATS_LABEL = "CSV · TSV · XLSX · XLS · Parquet · Feather · JSON · JSONL";

/** Starter questions shaped by the first dataset's columns, so they fit the data. */
function starters(datasets: DataChatDataset[]): string[] {
  const d = datasets[0];
  if (!d) return [];
  const cols = d.columns;
  const num = cols.find(([, t]) => /int|float|numeric|decimal|double|real|money/i.test(t))?.[0];
  const cat = cols.find(([, t]) => /object|string|category|char|text/i.test(t))?.[0];
  const date = cols.find(([n, t]) => /date|time/i.test(t) || /date|month|period|_at$/i.test(n))?.[0];
  const out = [`Give me an overview of ${d.name}: size, columns, missing values and anything unusual.`];
  if (cat && num) out.push(`Which ${cat} has the highest total ${num}? Show it as a chart.`);
  if (date && num) out.push(`How does ${num} trend over ${date}? Plot it and point out any spikes.`);
  if (num) out.push(`What drives ${num}? Check correlations and the strongest relationships.`);
  if (datasets.length > 1) out.push(`How are ${datasets[0].name} and ${datasets[1].name} related? Can they be joined?`);
  return out.slice(0, 4);
}

// ── Pieces of an answer ──────────────────────────────────────────────────────

/** Download / pin controls under a chat table or chart (only inside Data chat, where `sid` is known). */
function ResultActions({
  sid,
  tableRef,
  chartName,
  onPin,
  pinned,
}: {
  sid?: string;
  tableRef?: string;
  chartName?: string;
  onPin?: () => void;
  pinned?: boolean;
}) {
  if (!sid) return null;
  const link = "font-mono text-[10.5px] uppercase tracking-[0.08em] text-mute hover:text-ink";
  return (
    <span className="flex items-center gap-3">
      {tableRef && (
        <>
          <a href={`/api/datachat/sessions/${sid}/tables/${tableRef}?format=xlsx`} className={link}>
            Excel
          </a>
          <a href={`/api/datachat/sessions/${sid}/tables/${tableRef}?format=csv`} className={link}>
            CSV
          </a>
        </>
      )}
      {chartName && (
        <a href={`/api/datachat/sessions/${sid}/charts/${chartName}.png`} className={link}>
          PNG
        </a>
      )}
      {onPin && (
        <button onClick={onPin} disabled={pinned} className={cx(link, pinned && "text-moss hover:text-moss")}>
          {pinned ? "Pinned ✓" : "Pin"}
        </button>
      )}
    </span>
  );
}

export function ResultTable({ t, sid, onPin, pinned }: { t: DataChatTable; sid?: string; onPin?: () => void; pinned?: boolean }) {
  return (
    <div className="mt-2 overflow-x-auto border border-rule bg-white">
      <table className="w-full border-collapse font-mono text-[11.5px] tabular-nums">
        <thead>
          <tr>
            {t.columns.map((c) => (
              <th
                key={c}
                className="border-b-[1.5px] border-ink px-2.5 py-1.5 text-left font-sans text-[10px] font-semibold uppercase tracking-[0.1em] text-mute"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {t.rows.map((r, i) => (
            <tr key={i} className="border-b border-rule last:border-0">
              {r.map((v, j) => (
                <td key={j} className="whitespace-nowrap px-2.5 py-1 text-ink/85">
                  {typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: 4 }) : String(v ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(t.shape?.[0] > t.rows.length || (sid && (t.ref || onPin))) && (
        <div className="flex items-center justify-between gap-3 border-t border-rule px-2.5 py-1 text-[11px] text-mute">
          <span>
            {t.shape?.[0] > t.rows.length ? `Showing ${t.rows.length} of ${t.shape[0].toLocaleString()} rows × ${t.shape[1]} columns` : ""}
          </span>
          <ResultActions sid={sid} tableRef={t.ref} onPin={onPin} pinned={pinned} />
        </div>
      )}
    </div>
  );
}

function Step({ step, n }: { step: DataChatStep; n: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-rule last:border-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 py-1.5 text-left text-[12px] text-graphite hover:text-ink"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="font-mono uppercase tracking-[0.08em]">
          {step.tool === "sql" ? "SQL" : "Python"} · {n}
        </span>
        {step.saved_as && <span className="font-mono text-mute">→ {step.saved_as}</span>}
        {!step.ok && <span className="font-mono text-signal">error</span>}
        {step.charts?.length ? <span className="font-mono text-moss">chart</span> : null}
      </button>
      {open && (
        <div className="pb-3 pl-5">
          <pre className="overflow-x-auto bg-ink px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-paper">{step.input}</pre>
          {step.error && <p className="mt-1.5 font-mono text-[11.5px] text-signal">{step.error}</p>}
          {step.table && <ResultTable t={step.table} />}
        </div>
      )}
    </div>
  );
}

export function Chart({
  url,
  kind,
  sid,
  onPin,
  pinned,
}: {
  url: string;
  kind: "html" | "png";
  sid?: string;
  onPin?: () => void;
  pinned?: boolean;
}) {
  const lightbox = useLightbox();
  const name = url
    .split("/")
    .pop()
    ?.replace(/\.(html|png)$/, "");
  if (kind === "png") {
    return (
      <figure className="mt-4 inline-block border border-rule bg-white p-1.5">
        <button onClick={() => lightbox(url)} className="block cursor-zoom-in">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="Generated chart" className="max-h-[420px]" />
        </button>
        {sid && (
          <figcaption className="mt-1 flex justify-end">
            <ResultActions sid={sid} chartName={name} onPin={onPin} pinned={pinned} />
          </figcaption>
        )}
      </figure>
    );
  }
  return (
    <figure className="mt-4 border border-rule bg-white">
      {/* Charts are AI-generated pages: scripts may run, but never with this app's origin. */}
      <iframe src={url} sandbox="allow-scripts" title="Interactive chart" className="h-[440px] w-full" loading="lazy" />
      <figcaption className="flex items-center justify-end gap-3 border-t border-rule px-2.5 py-1">
        <ResultActions sid={sid} chartName={name} onPin={onPin} pinned={pinned} />
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-mute hover:text-ink"
        >
          Open full size ↗
        </a>
      </figcaption>
    </figure>
  );
}

const FLAG_TEXT: Record<string, string> = {
  pii_masked: "personal data masked",
  pii_redacted_input: "personal data removed from your question",
  pii_redacted_output: "personal data redacted from the answer",
  pii_redacted_tool_output: "personal data redacted from results",
  instructions_in_data_flagged: "instruction-like text found in the data and ignored",
  sql_blocked: "unsafe SQL blocked",
  code_blocked: "unsafe code blocked",
  external_links_removed: "external links removed",
  prompt_leak_blocked: "prompt leak blocked",
};

function flagText(f: string) {
  if (f.startsWith("blocked_")) return `blocked: ${f.slice(8).replace(/_/g, " ")}`;
  return FLAG_TEXT[f] || f.replace(/_/g, " ");
}

function SecurityNote({ flags }: { flags?: string[] }) {
  if (!flags?.length) return null;
  const alert = flags.some((f) => f.startsWith("blocked_") || f.endsWith("_flagged") || f.endsWith("_blocked"));
  return (
    <p className={cx("mt-3 font-mono text-[10.5px] uppercase tracking-[0.08em]", alert ? "text-ochre" : "text-mute")}>
      Guard · {flags.map(flagText).join(" · ")}
    </p>
  );
}

function Answer({
  m,
  sid,
  turn,
  pinned,
  onPin,
  onAsk,
  last,
  busy,
}: {
  m: DataChatMessage;
  sid?: string;
  turn?: number;
  pinned?: Set<string>;
  onPin?: (kind: "chart" | "table", index: number) => void;
  onAsk?: (q: string) => void;
  last?: boolean;
  busy?: boolean;
}) {
  if (m.error) return <p className="text-[14px] text-signal">{m.content}</p>;
  if (m.blocked)
    return (
      <div className="min-w-0 border-l-2 border-ochre pl-3">
        <p className="text-[14px] leading-relaxed text-graphite">{m.content}</p>
        <SecurityNote flags={m.security} />
      </div>
    );
  // The final table is shown under the answer (with download / pin); earlier ones stay inside their steps.
  const ti = (m.tables?.length ?? 0) - 1;
  const table = ti >= 0 ? m.tables![ti] : null;
  const isPinned = (kind: string, i: number) => !!pinned?.has(`${turn}:${kind}:${i}`);
  return (
    <div className="min-w-0">
      {m.steps && m.steps.length > 0 && (
        <div className="mb-4 border-l-2 border-rule pl-3">
          <div className="label mb-1 text-mute">
            Worked in {m.steps.length} step{m.steps.length > 1 ? "s" : ""}
            {m.seconds ? ` · ${m.seconds}s` : ""}
          </div>
          {m.steps.map((s, i) => (
            <Step key={i} step={s} n={i + 1} />
          ))}
        </div>
      )}
      <Markdown compact>{m.content}</Markdown>
      {m.charts?.map((c, ci) => (
        <Chart key={c.url} url={c.url} kind={c.kind} sid={sid} onPin={onPin && (() => onPin("chart", ci))} pinned={isPinned("chart", ci)} />
      ))}
      {table && <ResultTable t={table} sid={sid} onPin={onPin && (() => onPin("table", ti))} pinned={isPinned("table", ti)} />}
      <SecurityNote flags={m.security} />
      {last && onAsk && <Followups items={m.followups} onAsk={onAsk} disabled={busy} />}
    </div>
  );
}

/* ── Pinboard: charts and tables pinned from any chat; Refresh re-runs their steps on today's data ── */

function Pinboard({ pins, setPins, onOpen }: { pins: DataChatPin[]; setPins: (p: DataChatPin[]) => void; onOpen: (sid: string) => void }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  async function refresh(p: DataChatPin) {
    setBusy(p.id);
    setError("");
    try {
      const fresh = await postJSON<DataChatPin>(`/api/datachat/pins/${p.id}/refresh`);
      setPins(pins.map((x) => (x.id === p.id ? fresh : x)));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  }

  async function remove(p: DataChatPin) {
    try {
      await del(`/api/datachat/pins/${p.id}`);
      setPins(pins.filter((x) => x.id !== p.id));
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-10 lg:px-10">
      <header className="mb-6 border-b border-ink pb-4">
        <div className="label mb-2 text-signal">Pinboard</div>
        <div className="flex items-end justify-between gap-3">
          <h2 className="font-serif text-[1.8rem] font-medium leading-tight">Your pinned charts and tables</h2>
          <ShareButton createUrl="/api/datachat/pins/share" listUrl="/api/datachat/pins/shares" label="Share pinboard" />
        </div>
        <p className="mt-1.5 text-[12px] text-mute">
          Refresh re-runs the steps behind a pin on the current data. It&apos;s free: no AI call.
        </p>
      </header>
      {error && <ErrorNote>{error}</ErrorNote>}
      {pins.length === 0 ? (
        <p className="text-[13px] italic text-mute">Nothing pinned yet. Use “Pin” under any chart or table in a chat.</p>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {pins.map((p) => (
            <article key={p.id} className="min-w-0 border border-ink bg-white p-4">
              <div className="mb-2 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-[13.5px] font-medium leading-snug text-ink">{p.question || "Pinned result"}</h3>
                  <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
                    {p.chat} ·{" "}
                    {p.refreshed_at
                      ? `updated ${new Date(p.refreshed_at).toLocaleString()}`
                      : `pinned ${new Date(p.created_at).toLocaleDateString()}`}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2 text-[11.5px]">
                  <button onClick={() => refresh(p)} disabled={!!busy} className="text-graphite hover:text-ink disabled:opacity-40">
                    {busy === p.id ? "Refreshing…" : "Refresh"}
                  </button>
                  <button onClick={() => onOpen(p.sid)} className="text-graphite hover:text-ink">
                    Open chat
                  </button>
                  <button onClick={() => remove(p)} className="text-mute hover:text-signal" aria-label="Remove pin">
                    ×
                  </button>
                </div>
              </div>
              {p.kind === "chart" && p.chart && <Chart url={p.chart.url} kind={p.chart.kind} sid={p.sid} />}
              {p.kind === "table" && p.table && <ResultTable t={p.table} sid={p.sid} />}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Source picker ────────────────────────────────────────────────────────────

function NewSource({ onCreated }: { onCreated: (s: DataChatSession) => void }) {
  const [mode, setMode] = useState<"files" | "apps" | "database">("files");
  const [files, setFiles] = useState<File[]>([]);
  const [imports, setImports] = useState<ImportedFile[]>([]);
  const [drag, setDrag] = useState(false);
  const [uri, setUri] = useState("");
  const [schema, setSchema] = useState("");
  const [test, setTest] = useState<DbTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const all = Array.from(list);
    const ok = all.filter((f) => ACCEPT.split(",").some((ext) => f.name.toLowerCase().endsWith(ext)));
    setError(ok.length < all.length ? `Skipped unsupported files. Use ${FORMATS_LABEL}.` : "");
    setFiles((cur) => [...cur, ...ok.filter((f) => !cur.some((c) => c.name === f.name))].slice(0, 10));
  };

  async function testConnection() {
    setTesting(true);
    setTest(null);
    try {
      setTest(await postJSON<DbTestResult>("/api/db/test", { uri, schema }));
    } catch (e) {
      setTest({ ok: false, error: errorText(e) });
    } finally {
      setTesting(false);
    }
  }

  async function start() {
    const form = new FormData();
    if (mode === "files") files.forEach((f) => form.append("files", f));
    else if (mode === "apps") form.append("import_ids", imports.map((f) => f.file_id).join(","));
    else {
      form.append("db_uri", uri);
      form.append("db_schema", schema);
    }
    setBusy(true);
    setError("");
    try {
      onCreated(await postForm<DataChatSession>("/api/datachat/sessions", form));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const ready = mode === "files" ? files.length > 0 : mode === "apps" ? imports.length > 0 : uri.trim().length > 0;

  return (
    <div className="mx-auto max-w-[760px] px-6 py-10 lg:px-10">
      <header className="mb-8 border-b border-ink pb-4">
        <div className="label mb-2 text-signal">Chat with your data</div>
        <h2 className="font-serif text-[2rem] font-medium leading-[1.05] tracking-[-0.015em]">Bring a file or a database. Ask anything.</h2>
        <p className="mt-2 max-w-[60ch] text-[13px] leading-relaxed text-mute">
          A LangChain agent on Claude writes and runs Python (and read-only SQL) in a sandboxed session, shows every step, draws interactive
          charts, and explains what the numbers mean. Its tools come from a read-only FastMCP server, and personal data (names, emails,
          phones, IDs, addresses) is masked before the AI ever sees it.
        </p>
      </header>

      <div className="mb-6 flex gap-6 border-b border-rule" role="tablist">
        {(["files", "apps", "database"] as const).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={cx(
              "-mb-px border-b-2 pb-2 text-[13px] transition-colors",
              mode === m ? "border-ink font-medium text-ink" : "border-transparent text-graphite hover:text-ink",
            )}
          >
            {m === "files" ? "Upload files" : m === "apps" ? "Connect an app" : "Connect a database"}
          </button>
        ))}
      </div>

      {mode === "files" ? (
        <div>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              addFiles(e.dataTransfer.files);
            }}
            className={cx(
              "flex w-full flex-col items-center gap-2 border border-dashed px-6 py-12 text-center transition-colors",
              drag ? "border-signal bg-signal/5" : "border-ink/40 hover:border-ink hover:bg-ink/[0.02]",
            )}
          >
            <Upload size={22} />
            <span className="font-serif text-[1.25rem] italic text-graphite">Drop files here, or click to choose</span>
            <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-mute">{FORMATS_LABEL} · up to 200 MB each</span>
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          {files.length > 0 && (
            <ul className="mt-4 divide-y divide-rule border-y border-rule">
              {files.map((f) => (
                <li key={f.name} className="flex items-center justify-between gap-3 py-2 text-[13px]">
                  <span className="truncate">{f.name}</span>
                  <span className="flex items-center gap-3">
                    <span className="font-mono text-[11px] text-mute">{formatBytes(f.size)}</span>
                    <button
                      onClick={() => setFiles((c) => c.filter((x) => x !== f))}
                      className="text-mute hover:text-signal"
                      aria-label={`Remove ${f.name}`}
                    >
                      <X size={14} />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[11.5px] text-mute">Each Excel sheet becomes its own table. Several files can be analysed together.</p>
        </div>
      ) : mode === "apps" ? (
        <div>
          <AppConnectors
            tabularOnly
            onImported={(f) => setImports((cur) => [...cur.filter((x) => x.filename !== f.filename), f].slice(0, 10))}
          />
          {imports.length > 0 && (
            <ul className="mt-4 divide-y divide-rule border-y border-rule">
              {imports.map((f) => (
                <li key={f.file_id} className="flex items-center justify-between gap-3 py-2 text-[13px]">
                  <span className="min-w-0 truncate">
                    {f.filename}
                    <span className="ml-2 text-[11.5px] text-mute">from {f.source}</span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="font-mono text-[11px] text-mute">
                      {f.rows?.toLocaleString()} rows · {f.columns?.length} cols
                    </span>
                    <button
                      onClick={() => setImports((c) => c.filter((x) => x !== f))}
                      className="text-mute hover:text-signal"
                      aria-label={`Remove ${f.filename}`}
                    >
                      <X size={14} />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[11.5px] text-mute">
            Import from several apps to analyse them together; each import becomes its own table.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <Field
            label="Connection string"
            hint="Any SQLAlchemy URI, JDBC or ADO.NET string: Postgres, Supabase, MySQL, SQL Server, Oracle, Redshift, BigQuery, DuckDB, SQLite…"
          >
            <input
              value={uri}
              onChange={(e) => {
                setUri(e.target.value);
                setTest(null);
              }}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="postgresql://user:password@host:5432/dbname"
              className="w-full border-0 border-b border-rule bg-transparent py-2 font-mono text-[13px] focus:border-ink focus:outline-none"
            />
          </Field>
          <Field label="Schema (optional)">
            <input
              value={schema}
              onChange={(e) => setSchema(e.target.value)}
              spellCheck={false}
              placeholder="public"
              className="w-full border-0 border-b border-rule bg-transparent py-2 font-mono text-[13px] focus:border-ink focus:outline-none"
            />
          </Field>
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={testConnection} disabled={!uri.trim() || testing}>
              Test connection
            </Button>
            {testing && <Working label="Connecting" />}
            {test?.ok && (
              <span className="text-[12.5px] text-moss">
                Connected · {test.engine} on {test.provider}
              </span>
            )}
          </div>
          {test && !test.ok && (
            <ErrorNote>
              {test.error}
              {test.hint && <span className="mt-1 block text-graphite">{test.hint}</span>}
            </ErrorNote>
          )}
          <p className="text-[11.5px] text-mute">
            Read-only: the agent can only run SELECT queries. The connection string is never sent back to the browser.
          </p>
        </div>
      )}

      {error && (
        <div className="mt-5">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="mt-8 flex items-center gap-4">
        <Button tone="ink" size="lg" onClick={start} disabled={!ready || busy}>
          Start chatting
        </Button>
        {busy && <Working label={mode === "database" ? "Reading the schema" : "Loading and profiling your data"} />}
      </div>
    </div>
  );
}

// ── Side rail ────────────────────────────────────────────────────────────────

function DatasetList({ datasets, extra }: { datasets: DataChatDataset[]; extra: { name: string; rows: number }[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div>
      <div className="label mb-2">Tables</div>
      <ul className="space-y-0.5">
        {datasets.map((d) => (
          <li key={d.name}>
            <button
              onClick={() => setOpen(open === d.name ? null : d.name)}
              className="flex w-full items-baseline justify-between gap-2 py-1 text-left"
            >
              <span className="truncate font-mono text-[12px] text-ink">{d.name}</span>
              <span className="shrink-0 font-mono text-[10.5px] text-mute">
                {d.rows != null ? `${d.rows.toLocaleString()} × ` : ""}
                {d.columns.length} cols
                {d.masked && Object.keys(d.masked).length > 0 && <span className="text-ochre"> · PII</span>}
              </span>
            </button>
            {open === d.name && (
              <ul className="mb-2 ml-2 border-l border-rule pl-2">
                {d.columns.map(([c, t]) => (
                  <li key={c} className="flex justify-between gap-2 font-mono text-[10.5px] leading-5">
                    <span className="truncate text-graphite">{c}</span>
                    {d.masked?.[c] ? (
                      <span className="shrink-0 text-ochre" title="Pseudonymised before the AI sees it">
                        masked · {d.masked[c].toLowerCase()}
                      </span>
                    ) : (
                      <span className="shrink-0 text-mute">{t}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
        {extra.map((q) => (
          <li key={q.name} className="flex items-baseline justify-between gap-2 py-1">
            <span className="truncate font-mono text-[12px] text-moss">{q.name}</span>
            <span className="shrink-0 font-mono text-[10.5px] text-mute">{q.rows.toLocaleString()} rows · SQL</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── View ─────────────────────────────────────────────────────────────────────

export function DataChatView() {
  const [sessions, setSessions] = useState<DataChatSummary[]>([]);
  const [active, setActive] = useState<DataChatSession | null>(null);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [view, setView] = useState<"chat" | "pins">("chat");
  const [pins, setPins] = useState<DataChatPin[]>([]);
  const [ovLoading, setOvLoading] = useState(false);
  const [ovError, setOvError] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getJSON<DataChatPin[]>("/api/datachat/pins")
      .then(setPins)
      .catch(() => undefined);
  }, []);

  // Hand-off from Home's "Start here": open the sample chat.
  useEffect(
    () =>
      onIntent(["open_chat"], (i) => {
        if (i.type !== "open_chat") return;
        void open(i.sid);
        refresh();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // The data overview (profile + suggested questions) is built once per chat, the first time it's opened.
  const activeId = active?.id;
  const hasOverview = !!active?.overview;
  useEffect(() => {
    if (!activeId || hasOverview) return;
    let cancelled = false;
    setOvLoading(true);
    setOvError("");
    getJSON<DataChatOverview>(`/api/datachat/sessions/${activeId}/overview`)
      .then((ov) => !cancelled && setActive((a) => (a && a.id === activeId ? { ...a, overview: ov } : a)))
      .catch((e) => !cancelled && setOvError(errorText(e)))
      .finally(() => !cancelled && setOvLoading(false));
    return () => {
      cancelled = true;
    };
  }, [activeId, hasOverview]);

  const pinnedHere = new Set(pins.filter((p) => p.sid === active?.id).map((p) => `${p.turn}:${p.kind}:${p.index}`));

  async function pin(turn: number, kind: "chart" | "table", index: number) {
    if (!active) return;
    try {
      const p = await postJSON<DataChatPin>(`/api/datachat/sessions/${active.id}/pins`, { turn, kind, index });
      setPins((ps) => [p, ...ps]);
    } catch (e) {
      setLoadError(errorText(e));
    }
  }

  const refresh = useCallback(() => {
    getJSON<DataChatSummary[]>("/api/datachat/sessions")
      .then((s) => {
        setSessions(s);
        setLoadError("");
      })
      .catch((e) => setLoadError(errorText(e)));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Block body on purpose: an effect's return value is treated as its cleanup.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [active?.history.length, sending]);

  useEffect(() => {
    if (!sending) return;
    const t0 = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [sending]);

  async function open(id: string) {
    try {
      setView("chat");
      setActive(await getJSON<DataChatSession>(`/api/datachat/sessions/${id}`));
      setLoadError("");
    } catch (e) {
      setLoadError(errorText(e));
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this chat and its uploaded data?")) return;
    try {
      await del(`/api/datachat/sessions/${id}`);
      if (active?.id === id) setActive(null);
      refresh();
    } catch (e) {
      setLoadError(errorText(e));
    }
  }

  async function send(text: string) {
    const msg = text.trim();
    if (!msg || !active || sending) return;
    const id = active.id;
    setDraft("");
    setActive((a) => a && { ...a, history: [...a.history, { role: "user", content: msg }] });
    setSending(true);
    try {
      const reply = await postJSON<DataChatMessage>(`/api/datachat/sessions/${id}/message`, { message: msg });
      setActive((a) => (a && a.id === id ? { ...a, history: [...a.history, reply] } : a));
      // SQL steps add DataFrames to the session; pick them up for the side rail.
      if (reply.steps?.some((s) => s.tool === "sql" && s.ok)) {
        getJSON<DataChatSession>(`/api/datachat/sessions/${id}`)
          .then((s) => setActive((a) => (a && a.id === id ? { ...a, sql_frames: s.sql_frames } : a)))
          .catch(() => undefined);
      }
      refresh();
    } catch (e) {
      setActive((a) =>
        a && a.id === id ? { ...a, history: [...a.history, { role: "assistant", content: errorText(e), error: true }] } : a,
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <aside className="shrink-0 border-b border-rule bg-sheet/60 px-5 py-6 lg:w-[270px] lg:overflow-y-auto lg:border-b-0 lg:border-r">
        <Button
          tone="ink"
          size="sm"
          className="w-full"
          onClick={() => {
            setView("chat");
            setActive(null);
          }}
        >
          + New data chat
        </Button>
        <button
          onClick={() => setView(view === "pins" ? "chat" : "pins")}
          className={cx(
            "mt-2 flex w-full items-center justify-between border px-3 py-1.5 text-[12.5px] transition-colors",
            view === "pins" ? "border-ink bg-ink text-paper" : "border-rule text-graphite hover:border-ink hover:text-ink",
          )}
        >
          <span>Pinboard</span>
          <span className="font-mono text-[11px]">{pins.length}</span>
        </button>

        <div className="label mb-2 mt-6">Chats</div>
        {sessions.length === 0 ? (
          <p className="text-[12px] italic text-mute">None yet.</p>
        ) : (
          <ul className="max-h-[240px] space-y-0.5 overflow-y-auto lg:max-h-none">
            {sessions.map((s) => (
              <li key={s.id} className="group flex items-center gap-1">
                <button
                  onClick={() => open(s.id)}
                  className={cx(
                    "min-w-0 flex-1 border-l-2 py-1.5 pl-2 text-left transition-colors",
                    active?.id === s.id ? "border-signal text-ink" : "border-transparent text-graphite hover:text-ink",
                  )}
                >
                  <span className="block truncate text-[13px]">{s.title || "Untitled"}</span>
                  <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
                    {s.kind === "database" ? "Database" : "Files"} · {s.messages} question{s.messages === 1 ? "" : "s"}
                  </span>
                </button>
                <button
                  onClick={() => remove(s.id)}
                  className="p-1 text-mute opacity-0 transition-opacity hover:text-signal focus:opacity-100 group-hover:opacity-100"
                  aria-label="Delete chat"
                >
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {active && (
          <div className="mt-8 border-t border-rule pt-5">
            <div className="label mb-1">Source</div>
            <p className="mb-5 break-words text-[12.5px] text-graphite">{active.source.label}</p>
            <DatasetList datasets={active.datasets} extra={active.sql_frames} />
          </div>
        )}

        <div className="mt-8 border-t border-rule pt-5">
          <GlossaryPanel />
        </div>

        <div className="mt-8 border-t border-rule pt-5">
          <div className="label mb-2">Protection</div>
          <ul className="space-y-1.5 text-[11.5px] leading-snug text-graphite">
            <li>Read-only tools via a FastMCP server; SQL is parsed and only SELECT runs</li>
            <li>Personal data masked before the AI sees it</li>
            <li>Prompt-injection screening on questions and data</li>
            <li>Answers redacted; external links stripped; audit log</li>
          </ul>
        </div>
      </aside>

      <section className="flex min-h-[70vh] min-w-0 flex-1 flex-col lg:min-h-0">
        {loadError && (
          <div className="px-6 pt-4 lg:px-10">
            <ErrorNote>{loadError}</ErrorNote>
          </div>
        )}
        {view === "pins" ? (
          <div className="flex-1 overflow-y-auto">
            <Pinboard pins={pins} setPins={setPins} onOpen={(sid) => void open(sid)} />
          </div>
        ) : !active ? (
          <div className="flex-1 overflow-y-auto">
            <NewSource
              onCreated={(s) => {
                setActive(s);
                refresh();
              }}
            />
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto">
              <div className="mx-auto max-w-[880px] px-6 py-10 lg:px-10">
                <header className="mb-8 border-b border-ink pb-4">
                  <div className="label mb-2 text-signal">{active.source.kind === "database" ? "Database chat" : "File chat"}</div>
                  <h2 className="truncate font-serif text-[1.8rem] font-medium leading-tight">{active.title}</h2>
                  <p className="mt-1.5 text-[12px] text-mute">
                    {active.datasets.length} table{active.datasets.length === 1 ? "" : "s"} loaded · every answer shows the code behind it
                  </p>
                  {active.history.some((m) => m.role === "assistant" && !m.error && !m.blocked) && (
                    <div className="mt-4 max-w-[440px]">
                      <OpenStudio
                        prefix={`/api/datachat/sessions/${active.id}/studio`}
                        label="Turn this chat into"
                        note="Every question and answer, with its charts and tables. Edit by hand or ask the AI."
                      />
                    </div>
                  )}
                </header>

                <OverviewCard
                  ov={active.overview}
                  loading={ovLoading}
                  error={ovError}
                  onAsk={(q) => send(q)}
                  compact={active.history.length > 0}
                />

                {active.history.length === 0 && !active.overview && !ovLoading && (
                  <div className="space-y-2">
                    <p className="mb-3 font-serif text-[1.15rem] italic text-graphite">Start with one of these, or ask your own.</p>
                    {starters(active.datasets).map((s) => (
                      <button
                        key={s}
                        onClick={() => send(s)}
                        className="block w-full border-b border-rule py-2.5 text-left text-[14px] text-graphite transition-colors hover:border-ink hover:text-ink"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}

                <div className="space-y-9">
                  {active.history.map((m, i) => (
                    <div key={i} className="rise grid grid-cols-[64px_minmax(0,1fr)] gap-4">
                      <div
                        className={cx(
                          "pt-1 font-mono text-[11px] uppercase tracking-[0.08em]",
                          m.role === "user" ? "text-mute" : "text-signal",
                        )}
                      >
                        {m.role === "user" ? "You" : "Analyst"}
                      </div>
                      {m.role === "user" ? (
                        <p className="whitespace-pre-wrap text-[14.5px] font-medium leading-relaxed">{m.content}</p>
                      ) : (
                        <Answer
                          m={m}
                          sid={active.id}
                          turn={i}
                          pinned={pinnedHere}
                          onPin={(kind, index) => void pin(i, kind, index)}
                          onAsk={(q) => send(q)}
                          last={i === active.history.length - 1}
                          busy={sending}
                        />
                      )}
                    </div>
                  ))}
                  {sending && (
                    <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-4">
                      <div className="pt-1 font-mono text-[11px] uppercase tracking-[0.08em] text-signal">Analyst</div>
                      <Working label={`Writing and running code · ${elapsed}s`} />
                    </div>
                  )}
                </div>
                <div ref={endRef} />
              </div>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(draft);
              }}
              className="border-t border-ink bg-paper"
            >
              <div className="mx-auto flex max-w-[880px] items-end gap-3 px-6 py-4 lg:px-10">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send(draft);
                    }
                  }}
                  rows={1}
                  maxLength={4000}
                  placeholder="Ask about your data, or ask for a chart…"
                  className="max-h-36 min-h-[40px] flex-1 resize-none border-0 border-b border-rule bg-transparent py-2 font-serif text-[1.05rem] placeholder:italic placeholder:text-mute focus:border-ink focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={!draft.trim() || sending}
                  className="flex h-10 w-10 items-center justify-center bg-ink text-paper transition-colors hover:bg-signal disabled:opacity-30"
                  aria-label="Send"
                >
                  <Send size={16} />
                </button>
              </div>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
