"use client";

import { ArrowRight, ChevronDown, Upload, X } from "./icons";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { errorText, formatBytes, postForm, postJSON } from "@/lib/api";
import type { DbTestResult, RunRequest, UploadedFile } from "@/lib/types";
import { onIntent } from "@/lib/intent";
import { AppConnectors } from "./AppConnectors";
import { useToast } from "./Overlays";
import { Button, Field, Toggle, cx } from "./ui";

const ACCEPT = ["csv", "xlsx", "xls", "pdf", "docx", "doc", "pptx", "ppt"];

interface Pending {
  key: string;
  name: string;
  size: number;
  state: "uploading" | "ready" | "failed";
  info?: UploadedFile;
  error?: string;
  source?: string;
}

// What each provider's console hands you — all accepted as-is.
const DB_EXAMPLES: [string, string][] = [
  ["Supabase / Neon", "postgresql://user:pass@aws-0-region.pooler.supabase.com:5432/postgres"],
  ["AWS RDS / Aurora", "postgresql://admin:pass@mydb.xxxx.us-east-1.rds.amazonaws.com:5432/sales"],
  ["AWS Redshift", "redshift://awsuser:pass@cluster.xxxx.us-east-1.redshift.amazonaws.com:5439/dev"],
  ["GCP Cloud SQL", "postgresql://postgres:pass@34.101.0.10:5432/analytics"],
  ["GCP BigQuery", "bigquery://my-gcp-project/my_dataset"],
  ["Azure PostgreSQL", "postgresql://user:pass@myserver.postgres.database.azure.com:5432/postgres"],
  ["Azure SQL", "Server=tcp:myserver.database.windows.net,1433;Database=sales;User ID=admin;Password=pass;"],
  ["Snowflake", "snowflake://user:pass@account-id/DATABASE/SCHEMA?warehouse=WH"],
  ["MySQL / MariaDB", "mysql://user:pass@host:3306/shop"],
  ["Local", "postgresql://postgres:pass@localhost:5432/mydb  ·  sqlite:///C:/data/shop.db"],
];

function DatabaseSource({
  uri,
  setUri,
  schema,
  setSchema,
}: {
  uri: string;
  setUri: (v: string) => void;
  schema: string;
  setSchema: (v: string) => void;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<DbTestResult | null>(null);
  const [showExamples, setShowExamples] = useState(false);

  async function test(nextSchema = schema) {
    setTesting(true);
    setResult(null);
    try {
      setResult(await postJSON<DbTestResult>("/api/db/test", { uri, schema: nextSchema }));
    } catch (e) {
      setResult({ ok: false, error: errorText(e) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-2">
      <Field label="Database" hint="Any provider: paste the connection string from its console">
        <input
          value={uri}
          onChange={(e) => {
            setUri(e.target.value);
            setResult(null);
          }}
          placeholder="postgresql://… · mysql://… · Server=…; · jdbc:… · bigquery://…"
          className="field font-mono text-[12px]"
          spellCheck={false}
        />
      </Field>
      <div className="flex items-center gap-2">
        <input
          value={schema}
          onChange={(e) => {
            setSchema(e.target.value);
            setResult(null);
          }}
          placeholder="Schema (optional)"
          className="field w-40 font-mono text-[12px]"
          spellCheck={false}
        />
        <Button size="sm" tone="line" onClick={() => test()} disabled={!uri.trim() || testing}>
          {testing ? "Testing…" : "Test connection"}
        </Button>
        <button
          type="button"
          onClick={() => setShowExamples((s) => !s)}
          className="ml-auto text-[11.5px] text-mute underline-offset-2 hover:text-ink hover:underline"
        >
          {showExamples ? "Hide examples" : "Examples"}
        </button>
      </div>

      {showExamples && (
        <ul className="space-y-1 rounded-[3px] border border-rule bg-sheet p-2.5 text-[11px]">
          {DB_EXAMPLES.map(([name, ex]) => (
            <li key={name}>
              <span className="text-graphite">{name}</span>
              <div className="truncate font-mono text-mute" title={ex}>
                {ex}
              </div>
            </li>
          ))}
        </ul>
      )}

      {result && (
        <div
          className={cx("rounded-[3px] border p-2.5 text-[12px]", result.ok ? "border-moss/40 bg-moss/5" : "border-signal/40 bg-signal/5")}
        >
          {result.ok ? (
            <>
              <div className="text-ink">
                <span className="font-medium">Connected</span> · {result.engine} on {result.provider}
              </div>
              {result.version && <div className="truncate font-mono text-[10.5px] text-mute">{result.version}</div>}
              {result.hint && <div className="mt-1 text-signal">{result.hint}</div>}
              <ul className="mt-2 space-y-1.5">
                {(result.schemas || []).map((s) => (
                  <li key={s.name}>
                    <button
                      type="button"
                      onClick={() => {
                        setSchema(s.name);
                        test(s.name);
                      }}
                      className={cx("font-mono text-[11.5px] hover:underline", s.visible ? "text-moss" : "text-graphite")}
                      title="Use this schema"
                    >
                      {s.name}
                      {s.visible ? " ✓" : ""}
                    </button>
                    <span className="text-mute">
                      {" "}
                      · {s.tables.length} table{s.tables.length === 1 ? "" : "s"}:{" "}
                    </span>
                    <span className="text-graphite">
                      {s.tables
                        .slice(0, 6)
                        .map((t) => (t.rows != null ? `${t.name} (${t.rows.toLocaleString()})` : t.name))
                        .join(", ")}
                      {s.tables.length > 6 ? ", …" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <div className="font-medium text-signal">Couldn&apos;t connect{result.provider ? ` to ${result.provider}` : ""}</div>
              <div className="mt-0.5 text-graphite">{result.error}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const describe = (f: UploadedFile) =>
  f.type === "structured"
    ? `${f.rows?.toLocaleString() ?? "?"} rows · ${f.columns?.length ?? "?"} cols`
    : `${f.word_count?.toLocaleString() ?? "?"} words`;

export function RunBrief({ busy, onRun }: { busy: boolean; onRun: (req: RunRequest) => void }) {
  const toast = useToast();
  const [request, setRequest] = useState("");
  const [dbUri, setDbUri] = useState("");
  const [dbSchema, setDbSchema] = useState("");
  const [files, setFiles] = useState<Pending[]>([]);
  const [planning, setPlanning] = useState(true);
  const [campaign, setCampaign] = useState({
    brand_name: "",
    industry: "",
    target_audience: "",
    campaign_goals: "",
    budget: "",
    campaign_type: "Retention & Growth",
  });
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const uploading = files.some((f) => f.state === "uploading");

  // Hand-off from Home's "Start here": a suggested brief with the sample attached.
  useEffect(
    () =>
      onIntent(["prefill_analysis"], (i) => {
        if (i.type !== "prefill_analysis") return;
        setRequest(i.request);
        setFiles(
          i.files.map((f) => ({
            key: f.file_id,
            name: f.filename,
            size: f.size ?? 0,
            state: "ready" as const,
            info: f,
            source: "Sample data",
          })),
        );
      }),
    [],
  );

  async function upload(list: FileList | File[]) {
    for (const file of Array.from(list)) {
      const ext = file.name.split(".").pop()?.toLowerCase() || "";
      if (!ACCEPT.includes(ext)) {
        toast(`${file.name} is not a supported file type`, "warn");
        continue;
      }
      const key = `${file.name}-${file.size}-${Date.now()}`;
      setFiles((fs) => [...fs, { key, name: file.name, size: file.size, state: "uploading" }]);
      const form = new FormData();
      form.append("files", file);
      try {
        const res = await postForm<{ files: UploadedFile[] }>("/api/upload", form);
        setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, state: "ready", info: res.files[0] } : f)));
      } catch (e) {
        setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, state: "failed", error: errorText(e) } : f)));
        toast(`Upload failed: ${file.name}`, "bad");
      }
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
  }

  function submit() {
    onRun({
      database_uri: dbUri.trim(),
      database_schema: dbSchema.trim(),
      uploaded_file_ids: files.filter((f) => f.state === "ready" && f.info).map((f) => f.info!.file_id),
      analysis_request: request.trim(),
      use_langgraph: planning,
      brand_name: campaign.brand_name.trim() || "Brand",
      industry: campaign.industry.trim() || "General",
      target_audience: campaign.target_audience.trim() || "General audience",
      campaign_goals: campaign.campaign_goals.trim() || "Grow retention and engagement",
      budget: campaign.budget.trim() || "Not specified",
      campaign_type: campaign.campaign_type.trim() || "Retention & Growth",
    });
  }

  const set = (k: keyof typeof campaign) => (e: React.ChangeEvent<HTMLInputElement>) => setCampaign((c) => ({ ...c, [k]: e.target.value }));

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-8 overflow-y-auto px-6 py-7">
        <section className="rise">
          <div className="label mb-3">The brief</div>
          <textarea
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            rows={5}
            placeholder="What should the desk look into? Leave blank for a full analysis of whatever data you attach."
            className="w-full resize-none border-0 border-b border-rule bg-transparent pb-3 font-serif text-[1.2rem] leading-snug text-ink placeholder:italic placeholder:text-mute/80 focus:border-ink focus:outline-none"
          />
        </section>

        <section className="rise space-y-4" style={{ animationDelay: "60ms" }}>
          <div className="label">
            Sources <span className="normal-case tracking-normal text-mute/80">· all optional</span>
          </div>
          <DatabaseSource uri={dbUri} setUri={setDbUri} schema={dbSchema} setSchema={setDbSchema} />

          <div>
            <span className="label mb-1.5 block">Files</span>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              className={cx(
                "flex cursor-pointer items-center gap-3 border border-dashed px-4 py-4 transition-colors",
                dragging ? "border-signal bg-signal/5" : "border-mute/50 hover:border-ink",
              )}
            >
              <Upload size={16} className="shrink-0 text-graphite" />
              <span className="text-[12.5px] leading-snug text-graphite">
                Drop files or <span className="text-ink underline underline-offset-2">browse</span>
                <span className="block font-mono text-[10.5px] uppercase tracking-[0.08em] text-mute">csv · xlsx · pdf · docx · pptx</span>
              </span>
              <input
                ref={inputRef}
                type="file"
                multiple
                hidden
                accept={ACCEPT.map((e) => `.${e}`).join(",")}
                onChange={(e) => {
                  if (e.target.files) upload(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
            {files.length > 0 && (
              <ul className="mt-2 divide-y divide-rule border-y border-rule">
                {files.map((f) => (
                  <li key={f.key} className="flex items-center gap-3 py-2 text-[12.5px]">
                    <span className="w-9 shrink-0 font-mono text-[10px] uppercase text-mute">{f.name.split(".").pop()}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate" title={f.name}>
                        {f.name}
                      </span>
                      <span className={cx("block text-[11px]", f.state === "failed" ? "text-signal" : "text-mute")}>
                        {f.state === "uploading" && `Uploading · ${formatBytes(f.size)}`}
                        {f.state === "ready" && f.info && describe(f.info)}
                        {f.state === "ready" && f.source && ` · from ${f.source}`}
                        {f.state === "failed" && (f.error || "Upload failed")}
                      </span>
                    </span>
                    {f.state === "uploading" ? (
                      <span className="blink h-2 w-2 bg-signal" />
                    ) : (
                      <button
                        onClick={() => setFiles((fs) => fs.filter((x) => x.key !== f.key))}
                        className="text-mute hover:text-signal"
                        aria-label={`Remove ${f.name}`}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <details className="group" open>
            <summary className="flex cursor-pointer list-none items-center justify-between">
              <span className="label">
                From an app <span className="normal-case tracking-normal text-mute/80">· Sheets, Drive, Slack, Notion, Airtable, URL</span>
              </span>
              <ChevronDown size={14} className="text-mute transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-3">
              <AppConnectors
                onImported={(info) =>
                  setFiles((fs) => [
                    ...fs,
                    { key: `${info.file_id}`, name: info.filename, size: info.size, state: "ready", info, source: info.source },
                  ])
                }
              />
            </div>
          </details>
        </section>

        <details className="rise group" style={{ animationDelay: "120ms" }}>
          <summary className="flex cursor-pointer list-none items-center justify-between">
            <span className="label">Campaign details</span>
            <ChevronDown size={14} className="text-mute transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Field label="Brand">
              <input className="field" value={campaign.brand_name} onChange={set("brand_name")} placeholder="Brand" />
            </Field>
            <Field label="Industry">
              <input className="field" value={campaign.industry} onChange={set("industry")} placeholder="Banking" />
            </Field>
            <div className="col-span-2">
              <Field label="Audience">
                <input
                  className="field"
                  value={campaign.target_audience}
                  onChange={set("target_audience")}
                  placeholder="Who the campaign is for"
                />
              </Field>
            </div>
            <div className="col-span-2">
              <Field label="Goals">
                <input
                  className="field"
                  value={campaign.campaign_goals}
                  onChange={set("campaign_goals")}
                  placeholder="Grow retention and engagement"
                />
              </Field>
            </div>
            <Field label="Budget">
              <input className="field" value={campaign.budget} onChange={set("budget")} placeholder="$50,000" />
            </Field>
            <Field label="Campaign type">
              <input className="field" value={campaign.campaign_type} onChange={set("campaign_type")} />
            </Field>
          </div>
        </details>

        <section className="rise" style={{ animationDelay: "180ms" }}>
          <Toggle
            checked={planning}
            onChange={setPlanning}
            label="Plan first, then wait for my review"
            note="A LangGraph planner drafts the strategy and the run pauses for your approval."
          />
        </section>
      </div>

      <div className="border-t border-ink px-6 py-4">
        <Button tone="signal" size="lg" className="w-full justify-between" disabled={busy || uploading} onClick={submit}>
          {busy ? "Run in progress" : uploading ? "Waiting for uploads" : "Start the run"}
          <ArrowRight size={16} />
        </Button>
      </div>
    </div>
  );
}
