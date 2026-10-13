"use client";

// Data engineering desk: the dbt project the Data Engineer agent builds (lineage, model
// SQL, dbt test results, run history) and the Airflow schedule that keeps it fresh.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, Empty, ErrorNote, SectionHead, Working, cx } from "@/components/ui";
import { errorText, getJSON, postJSON } from "@/lib/api";
import type { AirflowStatus, DbtModelSource, DbtRun, DbtRunSummary } from "@/lib/types";

const LAYERS = ["sources", "staging", "intermediate", "marts"] as const;
const ok = (s: string) => s === "success" || s === "pass";
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={cx("inline-block h-2 w-2 shrink-0 rounded-full", ok(status) ? "bg-moss" : status === "warn" ? "bg-ochre" : "bg-signal")}
      title={status}
    />
  );
}

/** raw sources → staging → (intermediate) → marts, as columns of clickable nodes. */
function Lineage({ run, selected, onSelect }: { run: DbtRun; selected: string | null; onSelect: (m: string) => void }) {
  const cols = useMemo(() => {
    const byLayer: Record<string, { name: string; status: string }[]> = { sources: [], staging: [], intermediate: [], marts: [] };
    const sources = new Set(run.lineage.map(([a]) => a).filter((a) => a.startsWith("raw.")));
    sources.forEach((s) => byLayer.sources.push({ name: s, status: "success" }));
    run.models.forEach((m) => (byLayer[m.layer] || byLayer.staging).push({ name: m.name, status: m.status }));
    return LAYERS.filter((l) => byLayer[l].length).map((l) => ({ layer: l, nodes: byLayer[l] }));
  }, [run]);

  const W = 210, H = 44, GX = 70, GY = 16, PAD = 8;
  const pos: Record<string, { x: number; y: number }> = {};
  cols.forEach((c, ci) => c.nodes.forEach((n, ni) => (pos[n.name] = { x: PAD + ci * (W + GX), y: 28 + ni * (H + GY) })));
  const width = PAD * 2 + cols.length * W + Math.max(0, cols.length - 1) * GX;
  const height = 28 + Math.max(1, ...cols.map((c) => c.nodes.length)) * (H + GY);

  return (
    <div className="overflow-x-auto">
      <svg width={width} height={height} className="font-sans">
        {cols.map((c, ci) => (
          <text key={c.layer} x={PAD + ci * (W + GX)} y={14} className="fill-mute" fontSize={11} letterSpacing="0.12em">
            {c.layer.toUpperCase()}
          </text>
        ))}
        {run.lineage.map(([a, b]) => {
          const p = pos[a];
          const q = pos[b];
          if (!p || !q) return null;
          const x1 = p.x + W, y1 = p.y + H / 2, x2 = q.x, y2 = q.y + H / 2, mx = (x1 + x2) / 2;
          return <path key={a + b} d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" className="stroke-rule" strokeWidth={1.5} />;
        })}
        {cols.flatMap((c) => c.nodes.map((n) => {
          const p = pos[n.name];
          const isSource = c.layer === "sources";
          const active = selected === n.name;
          return (
            <g key={n.name} transform={`translate(${p.x},${p.y})`} style={{ cursor: isSource ? "default" : "pointer" }}
              onClick={() => !isSource && onSelect(n.name)}>
              <rect width={W} height={H} rx={3} className={active ? "fill-ink stroke-ink" : "fill-sheet stroke-rule"} />
              <circle cx={14} cy={H / 2} r={4} className={ok(n.status) ? "fill-moss" : "fill-signal"} />
              <text x={26} y={H / 2 + 4} fontSize={12.5} className={active ? "fill-paper" : "fill-ink"} fontFamily="var(--font-mono)">
                {n.name.length > 24 ? `${n.name.slice(0, 23)}…` : n.name}
              </text>
            </g>
          );
        }))}
      </svg>
    </div>
  );
}

function AirflowPanel() {
  const [st, setSt] = useState<AirflowStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    setErr("");
    getJSON<AirflowStatus>("/api/airflow/status").then(setSt).catch((e) => setErr(errorText(e)));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const trigger = async () => {
    setBusy(true);
    setErr("");
    try {
      await postJSON("/api/airflow/trigger");
      load();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="label text-signal">Orchestration</div>
          <h3 className="font-serif text-[1.35rem]">Airflow schedule</h3>
        </div>
        <div className="flex gap-2">
          <Button size="sm" tone="quiet" onClick={load}>Refresh</Button>
          {st?.reachable && <Button size="sm" tone="ink" onClick={trigger} disabled={busy}>{busy ? "Triggering…" : "Run now"}</Button>}
        </div>
      </div>
      {err && <ErrorNote>{err}</ErrorNote>}
      {!st && !err ? <Working label="Checking Airflow" /> : st && (!st.configured || !st.reachable) ? (
        <p className="text-[13px] leading-relaxed text-graphite">{st.message}</p>
      ) : st && (
        <>
          <p className="text-[13px] text-graphite">
            DAG <span className="font-mono text-ink">{st.dag_id}</span> · schedule <span className="font-mono text-ink">{st.schedule || "manual"}</span>
            {st.paused && <span className="ml-2 text-signal">(paused)</span>} ·{" "}
            <a className="underline decoration-rule underline-offset-2 hover:decoration-ink" href={st.ui_url} target="_blank" rel="noreferrer">open Airflow</a>
          </p>
          <ul className="mt-3 divide-y divide-rule border-y border-rule text-[12.5px]">
            {(st.runs || []).length === 0 && <li className="py-2 text-mute">No DAG runs yet.</li>}
            {(st.runs || []).map((r) => (
              <li key={r.run_id} className="flex items-center gap-3 py-2">
                <StatusDot status={r.state === "success" ? "success" : r.state === "running" || r.state === "queued" ? "warn" : "error"} />
                <span className="w-20 font-mono text-ink">{r.state}</span>
                <span className="text-graphite">{when(r.start)}</span>
                <span className="ml-auto truncate font-mono text-[11px] text-mute">{r.trigger || r.run_id}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

export function DataModelsView({ runId }: { runId?: string | null }) {
  const [runs, setRuns] = useState<DbtRunSummary[]>([]);
  const [run, setRun] = useState<DbtRun | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [source, setSource] = useState<DbtModelSource | null>(null);
  const [busy, setBusy] = useState<"" | "rebuild" | "design">("");
  const [goal, setGoal] = useState("");
  const [err, setErr] = useState("");

  const open = useCallback(async (id: string) => {
    try {
      const r = await getJSON<DbtRun>(`/api/dbt/runs/${id}`);
      setRun(r);
      setSelected(r.models.find((m) => m.layer === "marts")?.name || r.models[0]?.name || null);
    } catch (e) {
      setErr(errorText(e));
    }
  }, []);

  const loadRuns = useCallback(async (preferred?: string | null) => {
    try {
      const list = await getJSON<DbtRunSummary[]>("/api/dbt/runs");
      setRuns(list);
      const id = preferred || list[0]?.id;
      if (id) await open(id);
    } catch (e) {
      setErr(errorText(e));
    }
  }, [open]);

  useEffect(() => {
    loadRuns(runId);
  }, [loadRuns, runId]);

  useEffect(() => {
    if (!selected) {
      setSource(null);
      return;
    }
    getJSON<DbtModelSource>(`/api/dbt/models/${selected}`).then(setSource).catch(() => setSource(null));
  }, [selected, run?.id]);

  const act = async (kind: "rebuild" | "design") => {
    setBusy(kind);
    setErr("");
    try {
      const r = kind === "rebuild"
        ? await postJSON<DbtRun>("/api/dbt/rebuild")
        : await postJSON<DbtRun>("/api/dbt/build", { goal });
      await loadRuns(r.id);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy("");
    }
  };

  const testsByModel = useMemo(() => {
    const g: Record<string, { pass: number; total: number; failed: { name: string; message: string }[] }> = {};
    (run?.tests || []).forEach((t) => {
      const k = t.model || "—";
      g[k] ||= { pass: 0, total: 0, failed: [] };
      g[k].total++;
      if (ok(t.status)) g[k].pass++;
      else g[k].failed.push({ name: t.name, message: t.message });
    });
    return g;
  }, [run]);

  const passed = run?.tests.filter((t) => ok(t.status)).length || 0;

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-10 lg:px-10">
      <SectionHead
        kicker="Data engineering"
        title="Data models"
        aside={
          <div className="flex flex-wrap items-center gap-2">
            <input value={goal} onChange={(e) => setGoal(e.target.value)} disabled={!!busy}
              placeholder="Goal for a redesign (optional)"
              className="h-9 w-64 rounded-[3px] border border-rule bg-sheet px-3 text-[13px] outline-none focus:border-ink" />
            <Button tone="line" onClick={() => act("design")} disabled={!!busy} title="Claude redesigns the dbt project (~10k tokens)">
              {busy === "design" ? "Designing…" : "Redesign with AI"}
            </Button>
            <Button tone="ink" onClick={() => act("rebuild")} disabled={!!busy || !runs.length} title="Re-run dbt build — no AI">
              {busy === "rebuild" ? "Building…" : "Rebuild"}
            </Button>
          </div>
        }
      />

      {err && <div className="mb-6"><ErrorNote>{err}</ErrorNote></div>}
      {busy && (
        <div className="mb-6">
          <Working label={busy === "design" ? "Claude is designing models, then dbt builds and tests them (~2 min)" : "dbt build running"} />
        </div>
      )}

      {!run && !busy && (
        <Empty title="No dbt models yet.">
          The Data Engineer agent models your PostgreSQL data with dbt during each analysis run. You can also start one with “Redesign with AI”.
        </Empty>
      )}

      {run && (
        <div className="space-y-8">
          <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 border-b border-rule pb-4 text-[13px]">
            <span><span className="text-mute">Last build </span><span className="text-ink">{when(run.created_at)}</span></span>
            <span><span className="text-mute">Trigger </span><span className="font-mono text-ink">{run.trigger}</span></span>
            <span><span className="text-mute">Models </span><span className="text-ink">{run.models.length}</span></span>
            <span className={passed === run.tests.length ? "text-moss" : "text-signal"}>
              {passed}/{run.tests.length} dbt tests passed
            </span>
            {!!run.llm_usage?.calls && (
              <span className="text-mute">{(run.llm_usage.input_tokens + run.llm_usage.output_tokens).toLocaleString()} Claude tokens</span>
            )}
          </div>

          <section>
            <h3 className="label mb-3 text-mute">Lineage</h3>
            <Card className="p-4"><Lineage run={run} selected={selected} onSelect={setSelected} /></Card>
          </section>

          {source && (
            <section className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
              <div>
                <h3 className="label mb-3 text-mute">{source.layer} · {source.name}.sql</h3>
                <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-[3px] border border-rule bg-sheet p-4 font-mono text-[12px] leading-relaxed text-ink">
                  {source.sql}
                </pre>
              </div>
              <div>
                <h3 className="label mb-3 text-mute">Documented columns</h3>
                {source.doc.description && <p className="mb-3 text-[13px] leading-relaxed text-graphite">{source.doc.description}</p>}
                <ul className="max-h-[380px] divide-y divide-rule overflow-auto border-y border-rule text-[12.5px]">
                  {(source.doc.columns || []).map((c) => (
                    <li key={c.name} className="py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-ink">{c.name}</span>
                        {!!c.data_tests?.length && (
                          <span className="font-mono text-[10.5px] text-moss">{c.data_tests.length} test{c.data_tests.length > 1 ? "s" : ""}</span>
                        )}
                      </div>
                      {c.description && <div className="text-graphite">{c.description}</div>}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          <section className="grid gap-6 lg:grid-cols-2">
            <div>
              <h3 className="label mb-3 text-mute">dbt tests by model</h3>
              <ul className="divide-y divide-rule border-y border-rule text-[13px]">
                {Object.entries(testsByModel).map(([m, g]) => (
                  <li key={m} className="py-2.5">
                    <div className="flex items-center gap-2">
                      <StatusDot status={g.failed.length ? "fail" : "pass"} />
                      <span className="font-mono text-ink">{m}</span>
                      <span className="ml-auto tabular-nums text-graphite">{g.pass}/{g.total} passed</span>
                    </div>
                    {g.failed.map((f) => (
                      <p key={f.name} className="mt-1 pl-4 font-mono text-[11.5px] text-signal">{f.name}: {f.message}</p>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="label mb-3 text-mute">Build history</h3>
              <ul className="divide-y divide-rule border-y border-rule text-[12.5px]">
                {runs.map((r) => (
                  <li key={r.id}>
                    <button type="button" onClick={() => open(r.id)}
                      className={cx("flex w-full items-center gap-3 py-2 text-left hover:bg-ink/5", r.id === run.id && "font-medium")}>
                      <StatusDot status={r.ok ? "pass" : "fail"} />
                      <span className="text-graphite">{when(r.created_at)}</span>
                      <span className="font-mono text-[11px] text-mute">{r.trigger}</span>
                      <span className="ml-auto tabular-nums text-graphite">{r.tests_passed}/{r.tests_total}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <AirflowPanel />
        </div>
      )}
    </div>
  );
}
