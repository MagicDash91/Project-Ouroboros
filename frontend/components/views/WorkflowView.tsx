"use client";

import "@xyflow/react/dist/style.css";
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppConnectors } from "@/components/AppConnectors";
import { Markdown } from "@/components/Markdown";
import { onIntent } from "@/lib/intent";
import { useToast } from "@/components/Overlays";
import { ChevronDown, X } from "@/components/icons";
import { Button, cx } from "@/components/ui";
import { Chart, ResultTable } from "@/components/views/DataChatView";
import { del, errorText, getJSON, postForm, postJSON } from "@/lib/api";
import type { DataChatTable, ImportedFile } from "@/lib/types";

/** n8n-style workflow builder: drag steps, connect them, run, schedule — or describe it and let Claude build it. */

/* ── Types ────────────────────────────────────────────────────────────── */

type Category = "source" | "transform" | "logic" | "ml" | "ai" | "output";

interface FieldDef {
  key: string;
  label: string;
  kind: "text" | "textarea" | "number" | "select" | "column" | "columns" | "bool" | "file" | "secret";
  options?: string[];
  default?: unknown;
  required?: boolean;
  help?: string;
  placeholder?: string;
  min?: number;
  max?: number;
}

interface StepType {
  type: string;
  category: Category;
  label: string;
  description: string;
  inputs: 0 | 1 | 2;
  multi_input?: boolean;
  optional_input?: boolean;
  fields: FieldDef[];
}

interface WfNode {
  id: string;
  type: string;
  label: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
}

interface WfEdge {
  id: string;
  source: string;
  target: string;
  targetHandle: string | null;
}

type NodeStatus = "pending" | "running" | "done" | "error" | "skipped";

interface NodeResult {
  status: NodeStatus;
  seconds?: number;
  rows?: number;
  columns?: string[];
  table?: DataChatTable;
  text?: string;
  charts?: { url: string; kind: "html" | "png"; title?: string }[];
  files?: { name: string; url: string; kind: string }[];
  metrics?: Record<string, unknown>;
  error?: string;
}

interface Run {
  id: string;
  trigger: "manual" | "schedule";
  status: "running" | "completed" | "partial" | "failed";
  started_at: string;
  finished_at: string | null;
  nodes: Record<string, NodeResult>;
}

interface Schedule {
  enabled?: boolean;
  every?: "hour" | "day" | "week";
  at?: string;
  weekday?: number;
  next_run?: string | null;
  last_run?: string;
}

interface Workflow {
  id: string;
  name: string;
  description: string;
  nodes: WfNode[];
  edges: WfEdge[];
  schedule: Schedule;
  runs: Run[];
  files: { name: string; size: number; columns: string[] }[];
  running: boolean;
  explanation?: string;
}

interface WorkflowSummary {
  id: string;
  name: string;
  nodes: number;
  updated_at: string;
  last_status: string;
  running: boolean;
  schedule: Schedule;
}

type StepData = {
  label: string;
  stepType: string;
  config: Record<string, unknown>;
  status?: NodeStatus;
  result?: NodeResult;
  spec?: StepType;
};

type StepNode = Node<StepData, "step">;

/* ── Look ─────────────────────────────────────────────────────────────── */

const CAT: Record<Category, { label: string; color: string; glyph: string }> = {
  source: { label: "Sources", color: "#0E9F8E", glyph: "◆" },
  transform: { label: "Transform", color: "#475569", glyph: "⇄" },
  logic: { label: "Quality & logic", color: "#A87111", glyph: "◇" },
  ml: { label: "Machine learning", color: "#7A5195", glyph: "∿" },
  ai: { label: "AI", color: "#E4572E", glyph: "✦" },
  output: { label: "Outputs", color: "#118DFF", glyph: "▣" },
};

const STATUS: Record<NodeStatus, { label: string; cls: string }> = {
  pending: { label: "Waiting", cls: "bg-rule/60 text-mute" },
  running: { label: "Running", cls: "bg-signal/15 text-signal animate-pulse" },
  done: { label: "Done", cls: "bg-moss/15 text-moss" },
  error: { label: "Error", cls: "bg-signal text-white" },
  skipped: { label: "Skipped", cls: "bg-rule/60 text-mute" },
};

const IDEAS = [
  "Load my sales file, calculate revenue, show revenue by region as a bar chart and write AI insights.",
  "Forecast monthly revenue for the next 6 months from my sales data and put it in a PDF report.",
  "Every Monday at 8:00, research competitor prices for SGM, Bebelac and Dancow and make a report.",
  "Predict which customers will churn from my customer file and export the predictions to Excel.",
];

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/* ── Canvas node ──────────────────────────────────────────────────────── */

const StepCard = memo(function StepCard({ data, selected }: NodeProps<StepNode>) {
  const spec = data.spec;
  const cat = spec ? CAT[spec.category] : CAT.transform;
  const r = data.result;
  const status = data.status;
  const meta = [
    r?.rows !== undefined ? `${r.rows.toLocaleString()} rows` : "",
    r?.charts?.length ? `${r.charts.length} chart` : "",
    r?.files?.length ? `${r.files.length} files` : "",
    r?.seconds !== undefined ? `${r.seconds}s` : "",
  ].filter(Boolean);
  return (
    <div
      className={cx(
        "relative w-[230px] rounded-[6px] border bg-white shadow-[0_1px_2px_rgba(0,0,0,0.06),0_4px_14px_rgba(15,23,42,0.06)] transition-shadow",
        selected ? "border-ink ring-2 ring-ink/15" : "border-rule hover:border-graphite/50",
        status === "running" && "ring-2 ring-signal/40",
      )}
    >
      {spec && spec.inputs === 2 ? (
        <>
          <Handle type="target" id="left" position={Position.Left} style={{ top: "34%", background: cat.color }} />
          <Handle type="target" id="right" position={Position.Left} style={{ top: "70%", background: cat.color }} />
          <span className="pointer-events-none absolute -left-[38px] top-[26%] font-mono text-[9px] uppercase text-mute">left</span>
          <span className="pointer-events-none absolute -left-[42px] top-[62%] font-mono text-[9px] uppercase text-mute">right</span>
        </>
      ) : spec && spec.inputs >= 1 ? (
        <Handle type="target" position={Position.Left} style={{ background: cat.color }} />
      ) : null}
      <div className="flex items-center gap-2.5 px-3 pb-2 pt-2.5">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] text-[14px] text-white"
          style={{ background: cat.color }}
        >
          {cat.glyph}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-tight text-ink">{data.label}</div>
          <div className="truncate font-mono text-[10px] uppercase tracking-[0.06em] text-mute">{spec?.label ?? data.stepType}</div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-rule/70 px-3 py-1.5">
        {status ? (
          <span className={cx("rounded-[3px] px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.06em]", STATUS[status].cls)}>
            {STATUS[status].label}
          </span>
        ) : (
          <span className="font-mono text-[9.5px] uppercase tracking-[0.06em] text-mute/70">Not run</span>
        )}
        <span className="truncate font-mono text-[10px] text-mute">{meta.join(" · ")}</span>
      </div>
      {status === "error" && r?.error && (
        <div className="border-t border-signal/30 bg-signal/5 px-3 py-1.5 text-[10.5px] leading-snug text-signal">{r.error}</div>
      )}
      <Handle type="source" position={Position.Right} style={{ background: cat.color }} />
    </div>
  );
});

const nodeTypes = { step: StepCard };

/** Credits one run of a step costs (mirrors features/workflow.step_cost). */
function stepCredits(type: string, config: Record<string, unknown>, prices: Record<string, { credits: number }>) {
  const action =
    type === "web_search"
      ? "workflow_web_search"
      : type === "ai_insights"
        ? "workflow_ai_insights"
        : type === "report" && config.write_with_ai !== false
          ? "workflow_ai_report"
          : type === "agent"
            ? "agent_task"
            : "";
  return action ? (prices[action]?.credits ?? 0) : 0;
}

/* ── Settings form ────────────────────────────────────────────────────── */

function FieldInput({
  f,
  value,
  onChange,
  columns,
  files,
  onUpload,
  importEndpoint,
  onImported,
}: {
  f: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  columns: string[];
  files: { name: string }[];
  onUpload: (file: File) => Promise<string | null>;
  importEndpoint: string;
  onImported: (f: ImportedFile) => void;
}) {
  const base = "w-full border border-rule bg-white px-2.5 py-1.5 text-[12.5px] text-ink focus:border-ink focus:outline-none";
  const listId = `cols-${f.key}`;
  switch (f.kind) {
    case "textarea":
      return (
        <textarea
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          rows={f.key === "sql" ? 6 : 4}
          className={cx(base, f.key === "sql" && "font-mono text-[11.5px]")}
        />
      );
    case "number":
      return (
        <input
          type="number"
          value={value === undefined || value === null ? "" : String(value)}
          min={f.min}
          max={f.max}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          className={base}
        />
      );
    case "select":
      return (
        <select value={String(value ?? f.default ?? "")} onChange={(e) => onChange(e.target.value)} className={base}>
          {f.options?.map((o) => (
            <option key={o} value={o}>
              {o.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      );
    case "bool":
      return (
        <label className="flex items-center gap-2 text-[12.5px] text-graphite">
          <input type="checkbox" checked={Boolean(value ?? f.default)} onChange={(e) => onChange(e.target.checked)} />
          {f.label}
        </label>
      );
    case "column":
      return (
        <>
          <input
            list={listId}
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value)}
            placeholder={columns.length ? "Pick or type a column" : "Type a column (run once to list them)"}
            className={base}
          />
          <datalist id={listId}>
            {columns.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </>
      );
    case "columns": {
      const list = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div>
          <div className="flex flex-wrap gap-1">
            {list.map((c) => (
              <span key={c} className="flex items-center gap-1 border border-rule bg-sheet/60 py-0.5 pl-2 pr-0.5 font-mono text-[11px]">
                {c}
                <button
                  onClick={() => onChange(list.filter((x) => x !== c))}
                  className="p-0.5 text-mute hover:text-signal"
                  aria-label={`Remove ${c}`}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
          <select
            value=""
            onChange={(e) => e.target.value && onChange([...list, e.target.value])}
            className={cx(base, "mt-1.5")}
            disabled={!columns.length}
          >
            <option value="">{columns.length ? "+ Add column" : "Run once to list columns"}</option>
            {columns
              .filter((c) => !list.includes(c))
              .map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
          </select>
        </div>
      );
    }
    case "file":
      return (
        <div className="space-y-1.5">
          <select value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} className={base}>
            <option value="">{files.length ? "Choose an uploaded file" : "No files yet"}</option>
            {files.map((x) => (
              <option key={x.name} value={x.name}>
                {x.name}
              </option>
            ))}
          </select>
          <label className="block cursor-pointer border border-dashed border-rule px-2.5 py-2 text-center text-[12px] text-graphite hover:border-ink hover:text-ink">
            Upload CSV · Excel · Parquet · JSON
            <input
              type="file"
              className="hidden"
              accept=".csv,.tsv,.txt,.xlsx,.xls,.parquet,.json,.jsonl"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                const input = e.target;
                if (file) {
                  const name = await onUpload(file);
                  if (name) onChange(name);
                }
                input.value = "";
              }}
            />
          </label>
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between border border-dashed border-rule px-2.5 py-2 text-[12px] text-graphite hover:border-ink hover:text-ink">
              Or import from an app
              <ChevronDown size={13} className="text-mute transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-2">
              <AppConnectors
                tabularOnly
                endpoint={importEndpoint}
                onImported={(imp) => {
                  onImported(imp);
                  onChange(imp.filename);
                }}
              />
            </div>
          </details>
        </div>
      );
    case "secret":
      return (
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          placeholder={f.placeholder ?? "postgresql://user:password@host:5432/db"}
          className={cx(base, "font-mono text-[11.5px]")}
        />
      );
    default:
      return <input value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder} className={base} />;
  }
}

function Output({ r }: { r?: NodeResult }) {
  if (!r) return <p className="text-[12.5px] italic text-mute">Run the workflow to see this step&apos;s output.</p>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cx("rounded-[3px] px-1.5 py-0.5 font-mono text-[10px] uppercase", STATUS[r.status].cls)}>
          {STATUS[r.status].label}
        </span>
        {r.seconds !== undefined && <span className="font-mono text-[11px] text-mute">{r.seconds}s</span>}
        {r.rows !== undefined && (
          <span className="font-mono text-[11px] text-mute">
            {r.rows.toLocaleString()} rows × {r.columns?.length} cols
          </span>
        )}
      </div>
      {r.error && <p className="border-l-2 border-signal bg-signal/5 px-3 py-2 text-[12.5px] text-ink">{r.error}</p>}
      {r.metrics && Object.keys(r.metrics).length > 0 && (
        <div className="grid grid-cols-2 gap-1.5">
          {Object.entries(r.metrics).map(([k, v]) => (
            <div key={k} className="border border-rule bg-white px-2.5 py-1.5">
              <div className="font-mono text-[9.5px] uppercase tracking-[0.06em] text-mute">{k.replace(/_/g, " ")}</div>
              <div className="truncate text-[13px] font-semibold tabular-nums text-ink">{String(v)}</div>
            </div>
          ))}
        </div>
      )}
      {r.files && r.files.length > 0 && (
        <div className="space-y-1">
          {r.files.map((f) => (
            <a
              key={f.url}
              href={f.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 border border-ink bg-white px-3 py-1.5 text-[12px] text-ink hover:bg-ink hover:text-paper"
            >
              <span className="font-mono text-[10px] uppercase">{f.kind}</span>
              <span className="truncate">{f.name}</span>
            </a>
          ))}
        </div>
      )}
      {r.charts?.map((c) => (
        <Chart key={c.url} url={c.url} kind={c.kind} />
      ))}
      {r.text && (
        <div className="border border-rule bg-white px-4 py-3">
          <Markdown compact>{r.text}</Markdown>
        </div>
      )}
      {r.table && <ResultTable t={r.table} />}
    </div>
  );
}

/* ── Editor ───────────────────────────────────────────────────────────── */

function toFlow(w: Workflow, catalog: Record<string, StepType>, run?: Run) {
  const nodes: StepNode[] = w.nodes.map((n) => ({
    id: n.id,
    type: "step",
    position: n.position,
    data: {
      label: n.label,
      stepType: n.type,
      config: n.config,
      spec: catalog[n.type],
      status: run?.nodes[n.id]?.status,
      result: run?.nodes[n.id],
    },
  }));
  const edges: Edge[] = w.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, targetHandle: e.targetHandle ?? undefined }));
  return { nodes, edges };
}

function wouldCycle(edges: Edge[], source: string, target: string) {
  const out: Record<string, string[]> = {};
  edges.forEach((e) => (out[e.source] ||= []).push(e.target));
  const stack = [target];
  const seen = new Set<string>();
  while (stack.length) {
    const n = stack.pop()!;
    if (n === source) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(out[n] || []));
  }
  return false;
}

function Editor({
  wf,
  catalog,
  onSaved,
  onReplace,
}: {
  wf: Workflow;
  catalog: StepType[];
  onSaved: (w: Workflow) => void;
  onReplace: (w: Workflow) => void;
}) {
  const toast = useToast();
  const byType = useMemo(() => Object.fromEntries(catalog.map((c) => [c.type, c])), [catalog]);
  const latest = wf.runs[wf.runs.length - 1];
  const initial = useMemo(() => toFlow(wf, byType, latest), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [nodes, setNodes, onNodesChange] = useNodesState<StepNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<"settings" | "output">("settings");
  const [name, setName] = useState(wf.name);
  const [prompt, setPrompt] = useState("");
  const [building, setBuilding] = useState(false);
  const [running, setRunning] = useState(wf.running);
  const [explanation, setExplanation] = useState(wf.explanation || "");
  const [showSchedule, setShowSchedule] = useState(false);
  const [schedule, setSchedule] = useState<Schedule>(wf.schedule || {});
  const [files, setFiles] = useState(wf.files);
  const [importOpen, setImportOpen] = useState(false);
  const [runs, setRuns] = useState<Run[]>(wf.runs);
  const [run, setRun] = useState<Run | undefined>(latest);
  const { screenToFlowPosition, fitView } = useReactFlow();
  const [prices, setPrices] = useState<Record<string, { credits: number }>>({});
  useEffect(() => {
    getJSON<{ actions: Record<string, { credits: number }> }>("/api/billing/plans")
      .then((p) => setPrices(p.actions))
      .catch(() => {});
  }, []);
  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const graph = useRef({ nodes, edges, name });
  graph.current = { nodes, edges, name };

  const save = useCallback(async () => {
    clearTimeout(saveTimer.current);
    if (!dirty.current) return;
    dirty.current = false;
    const { nodes: ns, edges: es, name: nm } = graph.current;
    try {
      const saved = await fetch(`/api/workflows/${wf.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: nm,
          nodes: ns.map((n) => ({ id: n.id, type: n.data.stepType, label: n.data.label, position: n.position, config: n.data.config })),
          edges: es.map((e) => ({ id: e.id, source: e.source, target: e.target, targetHandle: e.targetHandle ?? null })),
        }),
      }).then((r) => (r.ok ? (r.json() as Promise<Workflow>) : Promise.reject(new Error(`save failed (${r.status})`))));
      onSaved(saved);
    } catch (e) {
      dirty.current = true;
      toast(errorText(e), "bad");
    }
  }, [wf.id, onSaved, toast]);

  // Debounced autosave whenever the graph or name changes.
  useEffect(() => {
    if (!dirty.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(save, 700);
  }, [nodes, edges, name, save]);

  useEffect(() => () => void save(), [save]); // flush on unmount

  const markDirty = () => (dirty.current = true);

  const applyRun = useCallback(
    (r?: Run) => {
      setRun(r);
      setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, status: r?.nodes[n.id]?.status, result: r?.nodes[n.id] } })));
    },
    [setNodes],
  );

  // Poll while running.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      try {
        const w = await getJSON<Workflow>(`/api/workflows/${wf.id}`);
        setRuns(w.runs);
        applyRun(w.runs[w.runs.length - 1]);
        if (!w.running) {
          setRunning(false);
          const s = w.runs[w.runs.length - 1]?.status;
          toast(
            s === "completed" ? "Workflow finished" : s === "partial" ? "Finished with some errors" : "Workflow failed",
            s === "completed" ? "ok" : "bad",
          );
        }
      } catch {
        /* keep polling */
      }
    }, 1200);
    return () => clearInterval(t);
  }, [running, wf.id, applyRun, toast]);

  // Columns a step can use = columns of its upstream steps' last outputs, else the uploaded files' columns.
  const columnsFor = useCallback(
    (nid: string, handle?: string) => {
      const ups = edges.filter((e) => e.target === nid && (!handle || e.targetHandle === handle)).map((e) => e.source);
      const cols = new Set<string>();
      ups.forEach((u) => run?.nodes[u]?.columns?.forEach((c) => cols.add(c)));
      if (!cols.size) {
        ups.forEach((u) => {
          const n = nodes.find((x) => x.id === u);
          const file = n?.data.stepType === "upload" ? String(n.data.config.file || "") : "";
          files.find((f) => f.name === file)?.columns.forEach((c) => cols.add(c));
        });
      }
      if (!cols.size) files.forEach((f) => f.columns.forEach((c) => cols.add(c)));
      return Array.from(cols);
    },
    [edges, nodes, run, files],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target) return;
      if (wouldCycle(edges, c.source, c.target)) {
        toast("That connection would create a loop", "warn");
        return;
      }
      const spec = nodes.find((n) => n.id === c.target)?.data.spec;
      markDirty();
      setEdges((es) => {
        const sameSlot = es.filter((e) => e.target === c.target && (e.targetHandle ?? null) === (c.targetHandle ?? null));
        const kept = spec && !spec.multi_input ? es.filter((e) => !sameSlot.includes(e)) : es; // one input per slot
        return addEdge({ ...c, id: `e-${c.source}-${c.target}-${c.targetHandle ?? "in"}` }, kept);
      });
    },
    [edges, nodes, setEdges, toast],
  );

  function addStep(type: string, pos?: { x: number; y: number }) {
    const spec = byType[type];
    if (!spec) return;
    const id = `${type.slice(0, 3)}${Math.random().toString(36).slice(2, 7)}`;
    const config: Record<string, unknown> = {};
    spec.fields.forEach((f) => f.default !== undefined && (config[f.key] = f.default));
    const position = pos ?? { x: 80 + (nodes.length % 4) * 280, y: 80 + Math.floor(nodes.length / 4) * 160 };
    markDirty();
    setNodes((ns) => [...ns, { id, type: "step", position, data: { label: spec.label, stepType: type, config, spec } }]);
    setSelected(id);
    setTab("settings");
  }

  function updateNode(id: string, patch: Partial<StepData>) {
    markDirty();
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
  }

  function removeNode(id: string) {
    markDirty();
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
    setSelected(null);
  }

  function imported(f: ImportedFile) {
    setFiles((fs) => [...fs.filter((x) => x.name !== f.filename), { name: f.filename, size: f.size, columns: f.columns ?? [] }]);
    toast(`Imported ${f.filename} from ${f.source} · ${(f.rows ?? 0).toLocaleString()} rows`, "ok");
  }

  async function upload(file: File): Promise<string | null> {
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await postForm<{ name: string; rows: number; columns: string[] }>(`/api/workflows/${wf.id}/files`, fd);
      setFiles((fs) => [...fs.filter((f) => f.name !== res.name), { name: res.name, size: file.size, columns: res.columns }]);
      toast(`Uploaded ${res.name} · ${res.rows.toLocaleString()} rows`, "ok");
      return res.name;
    } catch (e) {
      toast(errorText(e), "bad");
      return null;
    }
  }

  async function build() {
    if (prompt.trim().length < 6) return;
    setBuilding(true);
    try {
      await save();
      const w = await postJSON<Workflow>("/api/workflows/generate", { prompt, workflow_id: wf.id });
      onReplace(w);
    } catch (e) {
      toast(errorText(e), "bad");
      setBuilding(false);
    }
  }

  async function runNow() {
    try {
      await save();
      const w = await postJSON<Workflow>(`/api/workflows/${wf.id}/run`);
      setRuns(w.runs);
      applyRun(w.runs[w.runs.length - 1]);
      setRunning(true);
    } catch (e) {
      toast(errorText(e), "bad");
    }
  }

  async function saveSchedule(s: Schedule) {
    try {
      const w = await fetch(`/api/workflows/${wf.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schedule: s }),
      }).then((r) => r.json() as Promise<Workflow>);
      setSchedule(w.schedule);
      onSaved(w);
      toast(w.schedule.enabled ? `Scheduled · next run ${w.schedule.next_run?.replace("T", " ")}` : "Schedule turned off", "ok");
    } catch (e) {
      toast(errorText(e), "bad");
    }
  }

  // Credits per run: paid steps only (pricing.json); deterministic steps are free.
  const perRun = nodes.reduce((sum, n) => sum + stepCredits(n.data.stepType, n.data.config, prices), 0);
  const costLine = (s: Schedule) => {
    const runs = s.enabled ? { hour: 720, day: 30, week: 4 }[s.every || "day"] : 0;
    return `${perRun ? `${perRun.toLocaleString()} credits per run` : "Free per run (no paid steps)"}${
      runs && perRun ? `, about ${(perRun * runs).toLocaleString()} credits a month on this schedule.` : "."
    }`;
  };

  const sel = nodes.find((n) => n.id === selected);
  const selSpec = sel?.data.spec;
  const doneCount = run ? Object.values(run.nodes).filter((n) => n.status === "done").length : 0;

  const styledEdges = useMemo(
    () =>
      edges.map((e) => ({
        ...e,
        type: "smoothstep",
        animated: running && run?.nodes[e.target]?.status !== "done",
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "#94a3b8" },
        style: { stroke: "#94a3b8", strokeWidth: 1.6 },
      })),
    [edges, running, run],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-rule bg-paper px-4 py-2.5">
        <input
          value={name}
          onChange={(e) => {
            markDirty();
            setName(e.target.value);
          }}
          className="min-w-[150px] max-w-[260px] flex-1 bg-transparent font-serif text-[20px] text-ink focus:outline-none"
          aria-label="Workflow name"
        />
        <div className="flex min-w-[300px] flex-[2] items-center gap-2 rounded-[6px] border border-ink/80 bg-white py-1 pl-3 pr-1 focus-within:ring-2 focus-within:ring-signal/25">
          <span className="text-signal">✦</span>
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !building && build()}
            placeholder={nodes.length ? "Ask AI to change this workflow…" : "Describe the workflow you want; AI builds it…"}
            className="min-w-0 flex-1 bg-transparent py-1 text-[13px] text-ink placeholder:text-mute focus:outline-none"
          />
          <Button tone="signal" size="sm" onClick={build} disabled={building || prompt.trim().length < 6}>
            {building ? "Building…" : nodes.length ? "Update with AI" : "Build with AI"}
          </Button>
        </div>
        <div className="relative">
          <Button tone="line" size="sm" onClick={() => setShowSchedule(!showSchedule)}>
            {schedule.enabled ? `⏱ ${schedule.every === "hour" ? "Hourly" : schedule.every === "week" ? "Weekly" : "Daily"}` : "⏱ Schedule"}
          </Button>
          {showSchedule && (
            <div className="absolute right-0 top-10 z-20 w-[280px] border border-ink bg-white p-4 shadow-lg">
              <div className="label mb-3">Run automatically</div>
              <label className="mb-3 flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={Boolean(schedule.enabled)}
                  onChange={(e) => setSchedule({ ...schedule, enabled: e.target.checked })}
                />
                Enabled
              </label>
              <div className="grid grid-cols-2 gap-2 text-[12.5px]">
                <select
                  value={schedule.every || "day"}
                  onChange={(e) => setSchedule({ ...schedule, every: e.target.value as Schedule["every"] })}
                  className="border border-rule px-2 py-1.5"
                >
                  <option value="hour">Every hour</option>
                  <option value="day">Every day</option>
                  <option value="week">Every week</option>
                </select>
                <input
                  type="time"
                  value={schedule.at || "08:00"}
                  onChange={(e) => setSchedule({ ...schedule, at: e.target.value })}
                  className="border border-rule px-2 py-1.5"
                />
                {schedule.every === "week" && (
                  <select
                    value={schedule.weekday ?? 0}
                    onChange={(e) => setSchedule({ ...schedule, weekday: Number(e.target.value) })}
                    className="col-span-2 border border-rule px-2 py-1.5"
                  >
                    {WEEKDAYS.map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              {schedule.enabled && schedule.next_run && (
                <p className="mt-2 font-mono text-[10.5px] text-mute">Next: {schedule.next_run.replace("T", " ")}</p>
              )}
              <p className="mt-2 text-[11px] text-mute">{costLine(schedule)} Schedules run while the backend is running.</p>
              <div className="mt-3 flex justify-end gap-2">
                <Button tone="quiet" size="sm" onClick={() => setShowSchedule(false)}>
                  Close
                </Button>
                <Button
                  tone="ink"
                  size="sm"
                  onClick={() => {
                    saveSchedule(schedule);
                    setShowSchedule(false);
                  }}
                >
                  Save
                </Button>
              </div>
            </div>
          )}
        </div>
        <Button tone="ink" size="sm" onClick={runNow} disabled={running || !nodes.length}>
          {running ? `Running ${doneCount}/${nodes.length}…` : `▶ Run · ${perRun ? `${perRun.toLocaleString()} credits` : "free"}`}
        </Button>
      </div>

      {explanation && (
        <div className="flex items-start gap-3 border-b border-signal/30 bg-signal/[0.05] px-4 py-2.5">
          <span className="mt-0.5 text-signal">✦</span>
          <p className="flex-1 text-[12.5px] leading-relaxed text-ink">{explanation}</p>
          <button onClick={() => setExplanation("")} className="p-1 text-mute hover:text-ink" aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Palette */}
        <aside className="w-[200px] shrink-0 overflow-y-auto border-r border-rule bg-sheet/50 px-3 py-4">
          <div className="label mb-1">Steps</div>
          <p className="mb-3 text-[10.5px] leading-snug text-mute">
            Drag onto the canvas or click to add. Connect the right dot to the next step&apos;s left dot.
          </p>
          {(Object.keys(CAT) as Category[]).map((cat) => (
            <div key={cat} className="mb-3">
              <div
                className="mb-1 flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.08em]"
                style={{ color: CAT[cat].color }}
              >
                <span>{CAT[cat].glyph}</span>
                {CAT[cat].label}
              </div>
              {catalog
                .filter((c) => c.category === cat)
                .map((c) => (
                  <button
                    key={c.type}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData("application/uaa-step", c.type)}
                    onClick={() => addStep(c.type)}
                    title={c.description}
                    className="mb-1 flex w-full cursor-grab items-center gap-2 rounded-[4px] border border-rule bg-white px-2 py-1.5 text-left text-[12px] text-ink hover:border-ink active:cursor-grabbing"
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: CAT[cat].color }} />
                    <span className="truncate">{c.label}</span>
                  </button>
                ))}
            </div>
          ))}
        </aside>

        {/* Canvas */}
        <div
          className="relative min-w-0 flex-1 bg-[#F6F5F1]"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={(e) => {
            e.preventDefault();
            const type = e.dataTransfer.getData("application/uaa-step");
            if (type) addStep(type, screenToFlowPosition({ x: e.clientX - 110, y: e.clientY - 30 }));
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={styledEdges}
            nodeTypes={nodeTypes}
            onNodesChange={(ch) => {
              if (ch.some((c) => (c.type === "position" && !c.dragging) || c.type === "remove")) markDirty();
              onNodesChange(ch);
            }}
            onEdgesChange={(ch) => {
              if (ch.some((c) => c.type === "remove")) markDirty();
              onEdgesChange(ch);
            }}
            onConnect={onConnect}
            onNodeClick={(_, n) => {
              setSelected(n.id);
              setTab(run?.nodes[n.id] && run.nodes[n.id].status !== "pending" ? "output" : "settings");
            }}
            onPaneClick={() => setSelected(null)}
            fitView
            fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
            minZoom={0.25}
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={["Backspace", "Delete"]}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="#cbd5e1" />
            <Controls position="bottom-left" showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              position="bottom-right"
              nodeColor={(n) => CAT[((n.data as StepData).spec?.category ?? "transform") as Category].color}
              maskColor="rgba(246,245,241,0.7)"
            />
          </ReactFlow>

          {!nodes.length && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
              <div className="pointer-events-auto max-w-[560px] rounded-[8px] border border-rule bg-white/95 p-6 shadow-sm">
                <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-signal">Start here</div>
                <h3 className="mt-1 font-serif text-[24px] text-ink">Describe it, or drag steps in.</h3>
                <p className="mt-1 text-[12.5px] text-graphite">Type what you need in the AI bar above, or try one of these:</p>
                <ul className="mt-3 space-y-1.5">
                  {IDEAS.map((i) => (
                    <li key={i}>
                      <button
                        onClick={() => setPrompt(i)}
                        className="text-left text-[12.5px] text-ink underline decoration-rule underline-offset-4 hover:decoration-ink"
                      >
                        {i}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {nodes.length > 0 && (
            <button
              onClick={() => fitView({ padding: 0.25, maxZoom: 1, duration: 300 })}
              className="absolute right-3 top-3 z-10 rounded-[4px] border border-rule bg-white px-2.5 py-1 text-[11px] text-graphite shadow-sm hover:text-ink"
            >
              Fit to screen
            </button>
          )}
        </div>

        {/* Inspector */}
        <aside className="w-[360px] shrink-0 overflow-y-auto border-l border-rule bg-paper">
          {sel && selSpec ? (
            <div>
              <div className="border-b border-rule px-4 py-3" style={{ borderTop: `3px solid ${CAT[selSpec.category].color}` }}>
                <div className="flex items-center justify-between gap-2">
                  <input
                    value={sel.data.label}
                    onChange={(e) => updateNode(sel.id, { label: e.target.value })}
                    className="min-w-0 flex-1 bg-transparent font-serif text-[18px] text-ink focus:outline-none"
                  />
                  <button onClick={() => removeNode(sel.id)} className="text-[11.5px] text-mute hover:text-signal">
                    Delete
                  </button>
                </div>
                <p className="mt-0.5 text-[11.5px] text-mute">{selSpec.description}</p>
                <div className="mt-3 flex gap-4 text-[12px]">
                  {(["settings", "output"] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setTab(t)}
                      className={cx(
                        "border-b-2 pb-1 capitalize",
                        tab === t ? "border-ink font-medium text-ink" : "border-transparent text-graphite",
                      )}
                    >
                      {t}
                      {t === "output" && sel.data.status && (
                        <span className="ml-1 font-mono text-[10px] text-mute">· {STATUS[sel.data.status].label}</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
              <div className="px-4 py-4">
                {tab === "settings" ? (
                  <div className="space-y-3.5">
                    {selSpec.fields.map((f) => (
                      <div key={f.key}>
                        {f.kind !== "bool" && (
                          <label className="mb-1 block text-[11.5px] font-medium text-graphite">
                            {f.label}
                            {f.required && <span className="text-signal"> *</span>}
                          </label>
                        )}
                        <FieldInput
                          f={f}
                          value={sel.data.config[f.key]}
                          onChange={(v) => updateNode(sel.id, { config: { ...sel.data.config, [f.key]: v } })}
                          columns={columnsFor(
                            sel.id,
                            selSpec.inputs === 2 ? (f.key === "right_on" ? "right" : f.key === "left_on" ? "left" : undefined) : undefined,
                          )}
                          files={files}
                          onUpload={upload}
                          importEndpoint={`/api/workflows/${wf.id}/import`}
                          onImported={imported}
                        />
                        {f.help && <p className="mt-1 text-[10.5px] text-mute">{f.help}</p>}
                      </div>
                    ))}
                    {selSpec.inputs === 2 && (
                      <p className="text-[11px] text-mute">
                        Connect one table to the upper (left) input and one to the lower (right) input.
                      </p>
                    )}
                  </div>
                ) : (
                  <Output r={run?.nodes[sel.id]} />
                )}
              </div>
            </div>
          ) : (
            <div className="px-4 py-4">
              <div className="label mb-2">Workflow</div>
              <p className="text-[12.5px] leading-relaxed text-graphite">
                {wf.description || "Select a step to edit its settings or see its output."}
              </p>

              <div className="label mb-2 mt-6">Files · {files.length}</div>
              {files.map((f) => (
                <div key={f.name} className="mb-1 border border-rule bg-white px-2.5 py-1.5">
                  <div className="truncate font-mono text-[11.5px] text-ink">{f.name}</div>
                  <div className="truncate text-[10.5px] text-mute">
                    {f.columns.slice(0, 8).join(", ")}
                    {f.columns.length > 8 ? "…" : ""}
                  </div>
                </div>
              ))}
              <label className="mt-1 block cursor-pointer border border-dashed border-rule px-2.5 py-2 text-center text-[12px] text-graphite hover:border-ink hover:text-ink">
                Upload a data file
                <input
                  type="file"
                  className="hidden"
                  accept=".csv,.tsv,.txt,.xlsx,.xls,.parquet,.json,.jsonl"
                  onChange={(e) => {
                    const input = e.target;
                    if (input.files?.[0]) upload(input.files[0]).then(() => (input.value = ""));
                  }}
                />
              </label>
              <details className="group mt-2" open={importOpen} onToggle={(e) => setImportOpen((e.target as HTMLDetailsElement).open)}>
                <summary className="flex cursor-pointer list-none items-center justify-between border border-dashed border-rule px-2.5 py-2 text-[12px] text-graphite hover:border-ink hover:text-ink">
                  Import from an app
                  <ChevronDown size={13} className="text-mute transition-transform group-open:rotate-180" />
                </summary>
                <div className="mt-2">
                  <AppConnectors tabularOnly endpoint={`/api/workflows/${wf.id}/import`} onImported={imported} />
                </div>
              </details>

              <div className="label mb-2 mt-6">Runs</div>
              {runs.length === 0 ? (
                <p className="text-[12px] italic text-mute">Not run yet.</p>
              ) : (
                <ul className="space-y-1">
                  {[...runs]
                    .reverse()
                    .slice(0, 10)
                    .map((r) => (
                      <li key={r.id}>
                        <button
                          onClick={() => applyRun(r)}
                          className={cx(
                            "flex w-full items-center justify-between border bg-white px-2.5 py-1.5 text-left text-[11.5px]",
                            run?.id === r.id ? "border-ink" : "border-rule hover:border-graphite",
                          )}
                        >
                          <span className="font-mono text-mute">{r.started_at.replace("T", " ").slice(5, 16)}</span>
                          <span className="font-mono text-[10px] uppercase text-mute">{r.trigger}</span>
                          <span className={cx("font-mono text-[10px] uppercase", r.status === "completed" ? "text-moss" : "text-signal")}>
                            {r.status}
                          </span>
                        </button>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/* ── App ──────────────────────────────────────────────────────────────── */

export function WorkflowView() {
  const toast = useToast();
  const [catalog, setCatalog] = useState<StepType[]>([]);
  const [list, setList] = useState<WorkflowSummary[]>([]);
  const [active, setActive] = useState<Workflow | null>(null);
  const [version, setVersion] = useState(0);

  const loadList = useCallback(() => {
    getJSON<WorkflowSummary[]>("/api/workflows")
      .then(setList)
      .catch(() => {});
  }, []);

  useEffect(() => {
    getJSON<StepType[]>("/api/workflows/catalog")
      .then(setCatalog)
      .catch(() => {});
    loadList();
    window.addEventListener("focus", loadList);
    return () => window.removeEventListener("focus", loadList);
  }, [loadList]);

  async function createNew() {
    try {
      const w = await postJSON<Workflow>("/api/workflows", { name: "Untitled workflow" });
      setActive(w);
      setVersion((v) => v + 1);
      loadList();
    } catch (e) {
      toast(errorText(e), "bad");
    }
  }

  async function open(id: string) {
    try {
      setActive(await getJSON<Workflow>(`/api/workflows/${id}`));
      setVersion((v) => v + 1);
    } catch (e) {
      toast(errorText(e), "bad");
    }
  }

  // Hand-off from Home's "Start here": open the sample workflow.
  useEffect(
    () =>
      onIntent(["open_workflow"], (i) => {
        if (i.type !== "open_workflow") return;
        void open(i.id);
        getJSON<WorkflowSummary[]>("/api/workflows")
          .then(setList)
          .catch(() => undefined);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  async function remove(id: string) {
    try {
      await del(`/api/workflows/${id}`);
      if (active?.id === id) setActive(null);
      loadList();
    } catch (e) {
      toast(errorText(e), "bad");
    }
  }

  const onSaved = useCallback((w: Workflow) => {
    setList((ls) => ls.map((l) => (l.id === w.id ? { ...l, name: w.name, nodes: w.nodes.length, schedule: w.schedule } : l)));
  }, []);

  const onReplace = useCallback(
    (w: Workflow) => {
      setActive(w);
      setVersion((v) => v + 1);
      loadList();
    },
    [loadList],
  );

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <aside className="shrink-0 border-b border-rule bg-sheet/60 px-4 py-5 lg:w-[230px] lg:overflow-y-auto lg:border-b-0 lg:border-r">
        <Button tone="ink" size="sm" className="w-full" onClick={createNew}>
          + New workflow
        </Button>
        <div className="label mb-2 mt-6">Workflows</div>
        {list.length === 0 ? (
          <p className="text-[12px] italic text-mute">None yet.</p>
        ) : (
          <ul className="space-y-0.5">
            {list.map((w) => (
              <li key={w.id} className="group flex items-center gap-1">
                <button
                  onClick={() => open(w.id)}
                  className={cx(
                    "min-w-0 flex-1 border-l-2 py-1.5 pl-2 text-left",
                    active?.id === w.id ? "border-signal text-ink" : "border-transparent text-graphite hover:text-ink",
                  )}
                >
                  <span className="block truncate text-[13px]">{w.name}</span>
                  <span className="block font-mono text-[10px] uppercase tracking-[0.06em] text-mute">
                    {w.nodes} steps{w.schedule?.enabled ? " · scheduled" : ""}
                    {w.running ? " · running" : w.last_status ? ` · ${w.last_status}` : ""}
                  </span>
                </button>
                <button
                  onClick={() => remove(w.id)}
                  className="p-1 text-mute opacity-0 hover:text-signal focus:opacity-100 group-hover:opacity-100"
                  aria-label="Delete workflow"
                >
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <main className="min-h-[640px] min-w-0 flex-1 lg:min-h-0">
        {active && catalog.length ? (
          <ReactFlowProvider key={`${active.id}-${version}`}>
            <Editor wf={active} catalog={catalog} onSaved={onSaved} onReplace={onReplace} />
          </ReactFlowProvider>
        ) : (
          <div className="mx-auto max-w-[720px] px-6 py-14">
            <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-signal">Workflow</div>
            <h1 className="mt-2 font-serif text-[34px] leading-tight text-ink">Automate your analysis, step by step.</h1>
            <p className="mt-2 text-[13.5px] leading-relaxed text-graphite">
              Chain sources, transforms, machine learning, AI and outputs on a canvas, or describe what you need and AI builds the workflow
              for you. Run it once, or schedule it to run every hour, day or week.
            </p>
            <div className="mt-6 grid gap-2 sm:grid-cols-5">
              {(Object.keys(CAT) as Category[]).map((c) => (
                <div key={c} className="border border-rule bg-white px-3 py-2.5">
                  <div className="text-[16px]" style={{ color: CAT[c].color }}>
                    {CAT[c].glyph}
                  </div>
                  <div className="mt-1 text-[12px] font-medium text-ink">{CAT[c].label}</div>
                  <div className="font-mono text-[10px] text-mute">{catalog.filter((x) => x.category === c).length} steps</div>
                </div>
              ))}
            </div>
            <Button tone="ink" size="md" className="mt-8" onClick={createNew}>
              + New workflow
            </Button>
          </div>
        )}
      </main>
    </div>
  );
}
