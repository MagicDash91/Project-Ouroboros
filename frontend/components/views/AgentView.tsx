"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AppConnectors } from "@/components/AppConnectors";
import { Markdown } from "@/components/Markdown";
import { OpenStudio } from "@/components/studio/OpenStudio";
import { onIntent } from "@/lib/intent";
import { useToast } from "@/components/Overlays";
import { ChevronDown, ChevronRight, X } from "@/components/icons";
import { Button, cx } from "@/components/ui";
import { Chart, ResultTable } from "@/components/views/DataChatView";
import { del, errorText, getJSON, postJSON } from "@/lib/api";
import type { DataChatTable, ImportedFile } from "@/lib/types";

/** Manus-style autonomous agent: goal → plan you approve → live run → answer + deliverables. */

type Status = "planning" | "review" | "running" | "completed" | "failed" | "cancelled";

interface AgentEvent {
  i: number;
  ts: string;
  type: "think" | "tool" | "note" | "error" | "done";
  tool?: string;
  input?: string;
  output?: string;
  text?: string;
  ok?: boolean | null;
  seconds?: number;
  results?: { title: string; url: string }[];
  page?: { title: string; url: string; file: string; chars: number };
  file?: string;
  charts?: { url: string; kind: "html" | "png" }[];
  tables?: DataChatTable[];
  deliverables?: Deliverable[];
}

interface Deliverable {
  title: string;
  kind: string;
  url: string;
}

interface SubAgent {
  id: string;
  item: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  steps: number;
  last: string;
  findings: string;
  file: string;
  sources: string[];
}

interface AgentTask {
  id: string;
  title: string;
  goal: string;
  status: Status;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  db_label: string;
  plan: { title: string; steps: string[]; wide_research?: { instruction: string; items: string[] }; deliverables?: string[] } | null;
  todo: { text: string; done: boolean }[];
  events: AgentEvent[];
  subagents: SubAgent[];
  deliverables: Deliverable[];
  sources: { url: string; title: string }[];
  files: { path: string; size: number }[];
  answer: string;
  error: string;
  usage?: { input: number; output: number; cache_read: number; calls: number };
}

type TaskSummary = Pick<AgentTask, "id" | "title" | "goal" | "status" | "created_at" | "db_label">;

const EXAMPLES = [
  "Compare the current prices of SGM, Bebelac and Dancow 800g milk powder across Indonesian online stores and make a short report.",
  "Research the top 5 coffee chains in Jakarta: number of outlets, price range and positioning. Put it in a spreadsheet.",
  "Find this year's consumer trends for Indonesian e-commerce and summarise them in a slide deck for a marketing meeting.",
];

const STATUS_LABEL: Record<Status, string> = {
  planning: "Planning",
  review: "Waiting for your approval",
  running: "Working",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const TOOL_LABEL: Record<string, string> = {
  update_todo: "Checklist",
  web_search: "Search",
  browse: "Browse",
  read_file: "Read file",
  write_file: "Write file",
  list_files: "Files",
  load_into_python: "Load data",
  run_python: "Python",
  describe_database: "Database",
  run_sql: "SQL",
  wide_research: "Parallel research",
  create_deliverable: "Deliverable",
};

const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

function elapsed(from?: string | null, to?: string | null) {
  if (!from) return "";
  const s = Math.max(0, Math.round(((to ? new Date(to) : new Date()).getTime() - new Date(from).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/* ── New task ─────────────────────────────────────────────────────────── */

function NewTask({ onCreated }: { onCreated: (t: AgentTask) => void }) {
  const toast = useToast();
  const [goal, setGoal] = useState("");
  const [showDb, setShowDb] = useState(false);
  const [uri, setUri] = useState("");
  const [schema, setSchema] = useState("");
  const [showApps, setShowApps] = useState(false);
  const [imports, setImports] = useState<ImportedFile[]>([]);

  // Hand-off from Home's "Start here": a suggested goal with the sample attached.
  useEffect(
    () =>
      onIntent(["prefill_agent"], (i) => {
        if (i.type !== "prefill_agent") return;
        setGoal(i.goal);
        setImports(i.files);
      }),
    [],
  );
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      onCreated(
        await postJSON<AgentTask>("/api/agent/tasks", {
          goal,
          db_uri: showDb ? uri : "",
          db_schema: showDb ? schema : "",
          import_ids: imports.map((f) => f.file_id),
        }),
      );
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[760px] px-6 py-12">
      <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-signal">Agent</div>
      <h1 className="mt-2 font-serif text-[34px] leading-tight text-ink">Give it a goal. It does the work.</h1>
      <p className="mt-2 text-[13.5px] leading-relaxed text-graphite">
        The agent plans the task, then browses the web, reads sources, runs analysis and writes the deliverable on its own. Repeated
        research fans out to parallel researchers. You approve the plan before anything runs.
      </p>

      <textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        rows={5}
        placeholder="e.g. Research our top 5 competitors' prices and promotions, and give me a pricing strategy deck."
        className="mt-6 w-full resize-y border border-ink bg-white px-4 py-3 text-[14px] leading-relaxed text-ink placeholder:text-mute focus:outline-none focus:ring-2 focus:ring-signal/30"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && goal.trim().length >= 8 && !busy) submit();
        }}
      />

      <button onClick={() => setShowDb(!showDb)} className="mt-3 flex items-center gap-1.5 text-[12.5px] text-graphite hover:text-ink">
        {showDb ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        Connect a database (optional, read-only)
      </button>
      {showDb && (
        <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_160px]">
          <input
            value={uri}
            onChange={(e) => setUri(e.target.value)}
            placeholder="postgresql://user:password@host:5432/db"
            className="border border-rule bg-white px-3 py-2 font-mono text-[12px] focus:border-ink focus:outline-none"
          />
          <input
            value={schema}
            onChange={(e) => setSchema(e.target.value)}
            placeholder="schema (optional)"
            className="border border-rule bg-white px-3 py-2 font-mono text-[12px] focus:border-ink focus:outline-none"
          />
        </div>
      )}

      <button onClick={() => setShowApps(!showApps)} className="mt-3 flex items-center gap-1.5 text-[12.5px] text-graphite hover:text-ink">
        {showApps ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        Bring in data from an app (optional: Sheets, Drive, Slack, Notion, Airtable, URL)
        {imports.length > 0 && <span className="text-moss">· {imports.length} attached</span>}
      </button>
      {showApps && (
        <div className="mt-2 border border-rule bg-white p-3">
          <AppConnectors onImported={(f) => setImports((cur) => [...cur.filter((x) => x.filename !== f.filename), f].slice(0, 10))} />
        </div>
      )}
      {imports.length > 0 && (
        <ul className="mt-2 divide-y divide-rule border-y border-rule">
          {imports.map((f) => (
            <li key={f.file_id} className="flex items-center justify-between gap-3 py-1.5 text-[12.5px]">
              <span className="min-w-0 truncate">
                {f.filename}
                <span className="ml-2 text-[11.5px] text-mute">
                  from {f.source} · {f.type === "structured" ? `${f.rows?.toLocaleString()} rows` : "document"}
                </span>
              </span>
              <button
                onClick={() => setImports((c) => c.filter((x) => x !== f))}
                className="text-mute hover:text-signal"
                aria-label={`Remove ${f.filename}`}
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-4">
        <Button tone="ink" size="md" disabled={busy || goal.trim().length < 8} onClick={submit}>
          {busy ? "Planning…" : "Plan this task"}
        </Button>
        <span className="text-[12px] text-mute">
          Planning is free · running costs 100 credits (8 web searches included) + 40 per parallel researcher
        </span>
      </div>

      <div className="label mb-2 mt-10">Try</div>
      <ul className="space-y-2">
        {EXAMPLES.map((ex) => (
          <li key={ex}>
            <button
              onClick={() => setGoal(ex)}
              className="text-left text-[13px] text-graphite underline decoration-rule underline-offset-4 hover:text-ink hover:decoration-ink"
            >
              {ex}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── Plan review ──────────────────────────────────────────────────────── */

function PlanReview({ task, onUpdate }: { task: AgentTask; onUpdate: (t: AgentTask) => void }) {
  const toast = useToast();
  const plan = task.plan!;
  const [steps, setSteps] = useState<string[]>(plan.steps);
  const [items, setItems] = useState<string[]>(plan.wide_research?.items ?? []);
  const [busy, setBusy] = useState(false);
  const researchers = plan.wide_research ? items.filter((i) => i.trim()).length : 0;
  const cost = 100 + researchers * 40;

  async function approve() {
    setBusy(true);
    try {
      onUpdate(
        await postJSON<AgentTask>(`/api/agent/tasks/${task.id}/approve`, {
          steps,
          wide_items: plan.wide_research ? items : undefined,
        }),
      );
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    try {
      onUpdate(await postJSON<AgentTask>(`/api/agent/tasks/${task.id}/cancel`));
    } catch (e) {
      toast(errorText(e), "bad");
    }
  }

  return (
    <div className="rise border border-ink bg-white">
      <div className="border-b border-rule px-5 py-4">
        <div className="label">The plan · edit anything before it runs</div>
      </div>
      <ol className="divide-y divide-rule">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-3 px-5 py-2.5">
            <span className="mt-2 w-5 shrink-0 font-mono text-[11px] text-mute">{i + 1}</span>
            <textarea
              value={s}
              rows={Math.max(1, Math.ceil(s.length / 95))}
              onChange={(e) => setSteps(steps.map((x, j) => (j === i ? e.target.value : x)))}
              className="w-full resize-none bg-transparent py-1.5 text-[13.5px] leading-relaxed text-ink focus:outline-none"
            />
            <button
              onClick={() => setSteps(steps.filter((_, j) => j !== i))}
              aria-label="Remove step"
              className="mt-1.5 p-1 text-mute hover:text-signal"
            >
              <X size={13} />
            </button>
          </li>
        ))}
      </ol>
      <div className="border-t border-rule px-5 py-2.5">
        <button onClick={() => setSteps([...steps, ""])} className="text-[12.5px] text-graphite hover:text-ink">
          + Add a step
        </button>
      </div>

      {plan.wide_research && (
        <div className="border-t border-rule bg-sheet/50 px-5 py-4">
          <div className="label">Parallel research · one researcher per item</div>
          <p className="mt-1 text-[12.5px] text-graphite">{plan.wide_research.instruction}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {items.map((it, i) => (
              <span key={i} className="flex items-center gap-1 border border-rule bg-white py-1 pl-2.5 pr-1 text-[12.5px]">
                <input
                  value={it}
                  onChange={(e) => setItems(items.map((x, j) => (j === i ? e.target.value : x)))}
                  className="w-[140px] bg-transparent focus:outline-none"
                />
                <button
                  onClick={() => setItems(items.filter((_, j) => j !== i))}
                  aria-label="Remove item"
                  className="p-0.5 text-mute hover:text-signal"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
            {items.length < 8 && (
              <button
                onClick={() => setItems([...items, ""])}
                className="border border-dashed border-rule px-2.5 py-1 text-[12.5px] text-graphite hover:border-ink hover:text-ink"
              >
                + Item
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink px-5 py-4">
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-mute">
          Costs {cost.toLocaleString()} credits{researchers ? ` (incl. ${researchers} researchers)` : ""} · searches after the 8th are 10
          credits each · refunded if it fails
        </span>
        <div className="flex gap-2">
          <Button tone="quiet" size="sm" onClick={discard} disabled={busy}>
            Discard
          </Button>
          <Button tone="ink" size="sm" onClick={approve} disabled={busy || !steps.some((s) => s.trim())}>
            {busy ? "Starting…" : "Approve & run"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── Live run ─────────────────────────────────────────────────────────── */

function EventRow({ ev }: { ev: AgentEvent }) {
  const [open, setOpen] = useState(false);
  if (ev.type === "think") {
    return <p className="py-2 font-serif text-[15px] italic leading-relaxed text-graphite">{ev.text}</p>;
  }
  if (ev.type === "note" || ev.type === "error" || ev.type === "done") {
    return (
      <p
        className={cx(
          "py-1.5 font-mono text-[11.5px]",
          ev.type === "error" ? "text-signal" : ev.type === "done" ? "text-moss" : "text-mute",
        )}
      >
        {ev.text}
      </p>
    );
  }
  const running = ev.ok === null || ev.ok === undefined;
  const detail = ev.tool === "browse" && ev.page ? ev.page.title || host(ev.page.url) : ev.input;
  return (
    <div className="border-b border-rule last:border-0">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2.5 py-2 text-left">
        <span className={cx("h-2 w-2 shrink-0 rounded-full", running ? "animate-pulse bg-signal" : ev.ok ? "bg-moss" : "bg-signal")} />
        <span className="w-[112px] shrink-0 font-mono text-[10.5px] uppercase tracking-[0.08em] text-mute">
          {TOOL_LABEL[ev.tool ?? ""] ?? ev.tool}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink/85">{detail}</span>
        {ev.seconds !== undefined && <span className="shrink-0 font-mono text-[10.5px] text-mute">{ev.seconds}s</span>}
        {open ? <ChevronDown size={13} className="shrink-0 text-mute" /> : <ChevronRight size={13} className="shrink-0 text-mute" />}
      </button>
      {ev.charts?.map((c) => (
        <Chart key={c.url} url={c.url} kind={c.kind} />
      ))}
      {open && (
        <div className="pb-3 pl-[22px]">
          {ev.input && ["run_python", "run_sql"].includes(ev.tool ?? "") && (
            <pre className="overflow-x-auto bg-ink px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-paper">{ev.input}</pre>
          )}
          {ev.results && (
            <ul className="space-y-1">
              {ev.results.map((r) => (
                <li key={r.url} className="text-[12px]">
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-ink underline decoration-rule underline-offset-2 hover:decoration-ink"
                  >
                    {r.title || r.url}
                  </a>{" "}
                  <span className="font-mono text-[10.5px] text-mute">{host(r.url)}</span>
                </li>
              ))}
            </ul>
          )}
          {ev.page && (
            <p className="text-[12px] text-graphite">
              <a
                href={ev.page.url}
                target="_blank"
                rel="noreferrer noopener"
                className="underline decoration-rule underline-offset-2 hover:decoration-ink"
              >
                {ev.page.url}
              </a>{" "}
              · {ev.page.chars.toLocaleString()} characters saved to <span className="font-mono">{ev.page.file}</span>
            </p>
          )}
          {ev.tables?.[0] && <ResultTable t={ev.tables[0]} />}
          {ev.output && !ev.results && !ev.page && (
            <pre className="mt-1.5 max-h-[260px] overflow-auto whitespace-pre-wrap bg-sheet/60 px-3 py-2 font-mono text-[11px] leading-relaxed text-graphite">
              {ev.output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function Researchers({ subs }: { subs: SubAgent[] }) {
  if (!subs.length) return null;
  const done = subs.filter((s) => s.status === "done").length;
  return (
    <section>
      <div className="label mb-2">
        Parallel researchers · {done}/{subs.length}
      </div>
      <ul className="space-y-1.5">
        {subs.map((s) => (
          <li key={s.id} className="border border-rule bg-white px-3 py-2">
            <div className="flex items-center gap-2">
              <span
                className={cx(
                  "h-2 w-2 shrink-0 rounded-full",
                  s.status === "running" && "animate-pulse bg-signal",
                  s.status === "done" && "bg-moss",
                  s.status === "queued" && "bg-rule",
                  (s.status === "failed" || s.status === "cancelled") && "bg-signal/40",
                )}
              />
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{s.item}</span>
              <span className="font-mono text-[10px] text-mute">{s.steps} steps</span>
            </div>
            {s.status === "running" && s.last && <p className="mt-0.5 truncate pl-4 font-mono text-[10.5px] text-mute">{s.last}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SidePanel({ task }: { task: AgentTask }) {
  const fileUrl = (p: string) => `/api/agent/tasks/${task.id}/files/${p.split("/").map(encodeURIComponent).join("/")}`;
  // Editable as a deck / document: the report if the agent wrote one, otherwise its final answer (+ spreadsheet data).
  const hasReport = task.status === "completed" && (task.deliverables.some((d) => d.kind === "md") || (task.answer || "").length > 80);
  return (
    <div className="space-y-7">
      {hasReport && (
        <section>
          <OpenStudio prefix={`/api/agent/tasks/${task.id}/studio`} />
        </section>
      )}
      {task.todo.length > 0 && (
        <section>
          <div className="label mb-2">Checklist</div>
          <ul className="space-y-1.5">
            {task.todo.map((t, i) => (
              <li key={i} className="flex gap-2 text-[12.5px] leading-snug">
                <span
                  className={cx(
                    "mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center border text-[9px]",
                    t.done ? "border-moss bg-moss text-white" : "border-graphite/50",
                  )}
                >
                  {t.done ? "✓" : ""}
                </span>
                <span className={cx(t.done ? "text-mute line-through decoration-rule" : "text-ink")}>{t.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Researchers subs={task.subagents} />

      {task.deliverables.length > 0 && (
        <section>
          <div className="label mb-2">Deliverables</div>
          <ul className="space-y-1.5">
            {task.deliverables.map((d) => (
              <li key={d.url}>
                <a
                  href={d.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 border border-ink bg-white px-3 py-2 text-[12.5px] text-ink hover:bg-ink hover:text-paper"
                >
                  <span className="font-mono text-[10px] uppercase">{d.kind}</span>
                  <span className="truncate">{d.title}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {task.files.length > 0 && (
        <section>
          <div className="label mb-2">Workspace · {task.files.length} files</div>
          <ul className="max-h-[220px] space-y-0.5 overflow-y-auto">
            {task.files.map((f) => (
              <li key={f.path} className="flex items-center gap-2 text-[11.5px]">
                <a
                  href={fileUrl(f.path)}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate font-mono text-graphite hover:text-ink"
                >
                  {f.path}
                </a>
                <span className="font-mono text-[10px] text-mute">{(f.size / 1024).toFixed(1)}k</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {task.sources.length > 0 && (
        <section>
          <div className="label mb-2">Sources · {task.sources.length}</div>
          <ul className="max-h-[220px] space-y-1 overflow-y-auto">
            {task.sources.map((s) => (
              <li key={s.url} className="truncate text-[11.5px]">
                <a href={s.url} target="_blank" rel="noreferrer noopener" className="text-graphite hover:text-ink" title={s.url}>
                  {s.title || host(s.url)}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function TaskView({ task, onUpdate }: { task: AgentTask; onUpdate: (t: AgentTask) => void }) {
  const toast = useToast();
  const live = task.status === "running" || task.status === "planning";
  const [, tick] = useState(0);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);

  useEffect(() => {
    if (task.status === "running") endRef.current?.scrollIntoView({ block: "nearest" });
  }, [task.events.length, task.status]);

  async function cancel() {
    try {
      onUpdate(await postJSON<AgentTask>(`/api/agent/tasks/${task.id}/cancel`));
    } catch (e) {
      toast(errorText(e), "bad");
    }
  }

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-8 lg:px-10">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-ink pb-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.12em]">
            <span className={cx(live && "animate-pulse", task.status === "completed" ? "text-moss" : "text-signal")}>
              {STATUS_LABEL[task.status]}
            </span>
            {task.started_at && <span className="text-mute">· {elapsed(task.started_at, task.finished_at)}</span>}
            {task.db_label && <span className="text-mute">· {task.db_label}</span>}
          </div>
          <h1 className="mt-1.5 font-serif text-[28px] leading-tight text-ink">{task.title}</h1>
          <p className="mt-1 max-w-[760px] text-[13px] text-graphite">{task.goal}</p>
        </div>
        {task.status === "running" && (
          <Button tone="line" size="sm" onClick={cancel}>
            Stop
          </Button>
        )}
      </div>

      {task.status === "planning" && <p className="mt-8 animate-pulse font-serif text-[18px] italic text-graphite">Drafting a plan…</p>}
      {task.error && <p className="mt-6 border-l-2 border-signal bg-signal/5 px-4 py-3 text-[13px] text-ink">{task.error}</p>}

      {task.status === "review" && task.plan && (
        <div className="mt-8 max-w-[820px]">
          <PlanReview task={task} onUpdate={onUpdate} />
        </div>
      )}

      {task.answer && (
        <section className="rise mt-8 border border-ink bg-white px-6 py-6">
          <div className="label mb-3">Answer</div>
          <Markdown>{task.answer}</Markdown>
        </section>
      )}

      {["running", "completed", "failed", "cancelled"].includes(task.status) && task.events.length > 0 && (
        <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
          <section className="min-w-0">
            <div className="label mb-2">Activity · {task.events.filter((e) => e.type === "tool").length} steps</div>
            <div className="border-t border-rule">
              {task.events.map((ev) => (
                <EventRow key={ev.i} ev={ev} />
              ))}
            </div>
            {task.status === "running" && <p className="mt-3 animate-pulse font-mono text-[11px] text-mute">working…</p>}
            <div ref={endRef} />
            {task.usage && !live && (
              <p className="mt-4 font-mono text-[10.5px] text-mute">
                {task.usage.calls} model calls · {(task.usage.input + task.usage.cache_read).toLocaleString()} input tokens (
                {Math.round((task.usage.cache_read / Math.max(1, task.usage.input + task.usage.cache_read)) * 100)}% cached) ·{" "}
                {task.usage.output.toLocaleString()} output
              </p>
            )}
          </section>
          <aside className="lg:sticky lg:top-4 lg:self-start">
            <SidePanel task={task} />
          </aside>
        </div>
      )}
    </div>
  );
}

/* ── App ──────────────────────────────────────────────────────────────── */

export function AgentView() {
  const toast = useToast();
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [active, setActive] = useState<AgentTask | null>(null);

  // A "prefill_agent" hand-off needs the new-task form on screen (it then picks the intent up itself).
  useEffect(() => {
    const show = (e: Event) => {
      if ((e as CustomEvent<{ type: string }>).detail?.type === "prefill_agent") setActive(null);
    };
    window.addEventListener("ouro:intent", show);
    return () => window.removeEventListener("ouro:intent", show);
  }, []);

  const loadList = useCallback(() => {
    getJSON<TaskSummary[]>("/api/agent/tasks")
      .then(setTasks)
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadList();
    window.addEventListener("focus", loadList);
    return () => window.removeEventListener("focus", loadList);
  }, [loadList]);

  // Poll the open task while it plans or runs.
  const activeId = active?.id;
  const activeLive = active?.status === "planning" || active?.status === "running";
  useEffect(() => {
    if (!activeId || !activeLive) return;
    const t = setInterval(() => {
      getJSON<AgentTask>(`/api/agent/tasks/${activeId}`)
        .then((next) => {
          setActive((cur) => (cur && cur.id === next.id ? next : cur));
          if (next.status !== "planning" && next.status !== "running") loadList();
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(t);
  }, [activeId, activeLive, loadList]);

  function show(t: AgentTask) {
    setActive(t);
    loadList();
  }

  async function open(id: string) {
    try {
      setActive(await getJSON<AgentTask>(`/api/agent/tasks/${id}`));
    } catch (e) {
      toast(errorText(e), "bad");
    }
  }

  async function remove(id: string) {
    try {
      await del(`/api/agent/tasks/${id}`);
      if (active?.id === id) setActive(null);
      loadList();
    } catch (e) {
      toast(errorText(e), "bad");
    }
  }

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <aside className="shrink-0 border-b border-rule bg-sheet/60 px-5 py-6 lg:w-[270px] lg:overflow-y-auto lg:border-b-0 lg:border-r">
        <Button tone="ink" size="sm" className="w-full" onClick={() => setActive(null)}>
          + New task
        </Button>
        <div className="label mb-2 mt-6">Tasks</div>
        {tasks.length === 0 ? (
          <p className="text-[12px] italic text-mute">None yet.</p>
        ) : (
          <ul className="max-h-[240px] space-y-0.5 overflow-y-auto lg:max-h-none">
            {tasks.map((t) => (
              <li key={t.id} className="group flex items-center gap-1">
                <button
                  onClick={() => open(t.id)}
                  className={cx(
                    "min-w-0 flex-1 border-l-2 py-1.5 pl-2 text-left transition-colors",
                    active?.id === t.id ? "border-signal text-ink" : "border-transparent text-graphite hover:text-ink",
                  )}
                >
                  <span className="block truncate text-[13px]">{t.title}</span>
                  <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-mute">{STATUS_LABEL[t.status]}</span>
                </button>
                <button
                  onClick={() => remove(t.id)}
                  className="p-1 text-mute opacity-0 transition-opacity hover:text-signal focus:opacity-100 group-hover:opacity-100"
                  aria-label="Delete task"
                >
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-8 border-t border-rule pt-5 text-[11.5px] leading-relaxed text-mute">
          <div className="label mb-2">Guardrails</div>
          Read-only: the agent can&apos;t send, post, buy or delete. Web pages are treated as data, never instructions. Internal network
          addresses are blocked. Database access is read-only with personal data masked.
        </div>
      </aside>

      <main className="min-w-0 flex-1 lg:overflow-y-auto">
        {active ? <TaskView task={active} onUpdate={show} /> : <NewTask onCreated={show} />}
      </main>
    </div>
  );
}
