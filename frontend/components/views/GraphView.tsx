"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText, getJSON } from "@/lib/api";
import type { GraphData, GraphNode } from "@/lib/types";
import { Refresh, X } from "../icons";
import { Button, Empty, ErrorNote, SectionHead, Working, cx } from "../ui";

// vis-network is loaded from unpkg at runtime (the same CDN the original page used),
// so the knowledge graph doesn't add a heavy npm dependency.
const VIS_SRC = "https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Vis = any;
declare global {
  interface Window {
    vis?: Vis;
  }
}

let visPromise: Promise<Vis> | null = null;
function loadVis(): Promise<Vis> {
  if (window.vis) return Promise.resolve(window.vis);
  visPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = VIS_SRC;
    s.async = true;
    s.onload = () => resolve(window.vis);
    s.onerror = () => {
      visPromise = null;
      reject(new Error("Could not load the graph library from unpkg.com"));
    };
    document.head.appendChild(s);
  });
  return visPromise;
}

// Earthy palette to sit on paper; groups mirror zep_graph.py.
const GROUPS: Record<string, { label: string; color: string; shape: string; size: number }> = {
  brand: { label: "Brand", color: "#181613", shape: "box", size: 26 },
  problem: { label: "Business problem", color: "#ce401b", shape: "ellipse", size: 22 },
  risk_factor: { label: "Risk factor", color: "#e0774f", shape: "ellipse", size: 17 },
  segment: { label: "Segment", color: "#2e6650", shape: "ellipse", size: 19 },
  forecast: { label: "Forecast", color: "#8c2a12", shape: "box", size: 20 },
  opportunity: { label: "Opportunity", color: "#4f8a5b", shape: "box", size: 17 },
  signal: { label: "Early signal", color: "#a87111", shape: "ellipse", size: 15 },
  market_force: { label: "Market force", color: "#5b4a7a", shape: "ellipse", size: 16 },
  campaign: { label: "Campaign", color: "#3e5f8a", shape: "box", size: 20 },
  competitor: { label: "Competitor", color: "#7d756b", shape: "ellipse", size: 16 },
  channel: { label: "Channel", color: "#6f9a8d", shape: "ellipse", size: 14 },
  exa_insight: { label: "Web intel", color: "#4a7fa5", shape: "ellipse", size: 13 },
  zep_entity: { label: "Zep entity", color: "#9a8bb5", shape: "ellipse", size: 14 },
  default: { label: "Entity", color: "#9c9286", shape: "ellipse", size: 13 },
};
const style = (g?: string) => GROUPS[g || "default"] || GROUPS.default;

const SENTIMENT: Record<string, { label: string; cls: string }> = {
  threatening: { label: "Threatening", cls: "bg-signal text-white" },
  negative: { label: "Negative", cls: "bg-[#e0774f] text-white" },
  warning: { label: "Warning", cls: "bg-ochre text-white" },
  neutral: { label: "Neutral", cls: "border border-mute text-graphite" },
  positive: { label: "Supportive", cls: "bg-moss text-white" },
};

const clean = (s: string) => s.replace(/\n/g, " ");

export function GraphView({ taskId, ready }: { taskId: string | null; ready: boolean }) {
  const holder = useRef<HTMLDivElement>(null);
  const network = useRef<Vis>(null);
  const nodesDS = useRef<Vis>(null);
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [physics, setPhysics] = useState(true);

  const load = useCallback(() => {
    if (!taskId) return;
    setLoading(true);
    setError(null);
    getJSON<GraphData>(`/api/graph/${taskId}`)
      .then(setData)
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, [taskId]);

  useEffect(() => {
    if (ready) load();
  }, [ready, load]);

  const presentGroups = useMemo(() => {
    const counts = new Map<string, number>();
    data?.nodes.forEach((n) => counts.set(n.group || "default", (counts.get(n.group || "default") || 0) + 1));
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [data]);

  // Build the network whenever new data arrives.
  useEffect(() => {
    if (!data?.nodes.length || !holder.current) return;
    let disposed = false;
    loadVis()
      .then((vis) => {
        if (disposed || !holder.current) return;
        const nodes = new vis.DataSet(
          data.nodes.map((n) => {
            const g = style(n.group);
            return {
              id: n.id,
              label: n.label,
              title: `${g.label}\n${clean(n.title || n.label)}`,
              shape: g.shape,
              size: g.size,
              color: {
                background: g.color,
                border: g.color,
                highlight: { background: g.color, border: "#181613" },
                hover: { background: g.color, border: "#181613" },
              },
              font: { color: g.shape === "box" ? "#fbf9f4" : "#181613", size: 12, face: "IBM Plex Sans, sans-serif" },
              borderWidth: 1,
              margin: g.shape === "box" ? 8 : undefined,
            };
          }),
        );
        const edges = new vis.DataSet(
          data.edges.map((e, i) => ({
            id: i,
            from: e.from,
            to: e.to,
            label: e.label,
            font: { size: 9, color: "#7d756b", face: "IBM Plex Mono, monospace", strokeWidth: 3, strokeColor: "#f3efe7" },
            color: { color: "rgba(24,22,19,.28)", highlight: "#ce401b", hover: "#181613" },
            arrows: { to: { enabled: true, scaleFactor: 0.45 } },
            smooth: { type: "continuous" },
            width: 1,
          })),
        );
        network.current?.destroy();
        nodesDS.current = nodes;
        network.current = new vis.Network(
          holder.current,
          { nodes, edges },
          {
            physics: {
              enabled: true,
              stabilization: { iterations: 250, fit: true },
              barnesHut: { gravitationalConstant: -4200, centralGravity: 0.22, springLength: 140, damping: 0.14 },
            },
            interaction: { hover: true, tooltipDelay: 120, keyboard: { enabled: true, bindToWindow: false } },
            nodes: { shadow: false },
          },
        );
        network.current.on("click", (p: { nodes: (string | number)[] }) => {
          setSelected(p.nodes.length ? data.nodes.find((n) => n.id === p.nodes[0]) || null : null);
        });
        setHidden(new Set());
        setPhysics(true);
      })
      .catch((e) => setError(errorText(e)));
    return () => {
      disposed = true;
    };
  }, [data]);

  useEffect(() => () => network.current?.destroy(), []);

  function toggleGroup(group: string) {
    const next = new Set(hidden);
    next.has(group) ? next.delete(group) : next.add(group);
    setHidden(next);
    nodesDS.current?.update(
      (data?.nodes || []).filter((n) => (n.group || "default") === group).map((n) => ({ id: n.id, hidden: next.has(group) })),
    );
  }

  return (
    <div className="mx-auto max-w-[1280px] px-6 py-10 lg:px-10">
      <SectionHead
        kicker="Memory · Zep temporal graph"
        title="Knowledge graph"
        aside={
          data?.nodes.length ? (
            <div className="flex items-center gap-2">
              <span className="mr-2 font-mono text-[12px] text-mute">
                {data.nodes.length} nodes · {data.edges.length} edges
              </span>
              <Button size="sm" tone="quiet" onClick={() => network.current?.fit({ animation: { duration: 500 } })}>
                Fit
              </Button>
              <Button
                size="sm"
                tone="quiet"
                onClick={() => {
                  network.current?.setOptions({ physics: { enabled: !physics } });
                  setPhysics(!physics);
                }}
              >
                {physics ? "Freeze" : "Unfreeze"}
              </Button>
              <Button size="sm" tone="line" onClick={load}>
                <Refresh size={13} /> Reload
              </Button>
            </div>
          ) : null
        }
      />

      {!ready ? (
        <Empty title="The graph is built from a finished run.">
          Entities, risks, segments and campaign ideas from both teams are linked here once the pipeline completes.
        </Empty>
      ) : loading && !data ? (
        <Working label="Loading graph" />
      ) : error ? (
        <ErrorNote>{error}</ErrorNote>
      ) : !data?.nodes.length ? (
        <Empty title="This run produced no graph." />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-x-4 gap-y-2">
            {presentGroups.map(([g, n]) => (
              <button
                key={g}
                onClick={() => toggleGroup(g)}
                className={cx("flex items-center gap-1.5 text-[12px] transition-opacity", hidden.has(g) && "line-through opacity-40")}
                title={hidden.has(g) ? "Show" : "Hide"}
              >
                <span className="h-2.5 w-2.5" style={{ background: style(g).color }} />
                {style(g).label}
                <span className="font-mono text-[11px] text-mute">{n}</span>
              </button>
            ))}
          </div>

          <div className="relative">
            <div ref={holder} className="h-[560px] border border-ink bg-sheet" />
            {selected && (
              <div className="rise absolute bottom-4 right-4 w-[300px] border border-ink bg-paper shadow-[4px_4px_0_rgb(var(--ink)/0.12)]">
                <div className="flex items-start justify-between gap-3 border-b border-rule px-4 py-3">
                  <div>
                    <div className="label mb-1" style={{ color: style(selected.group).color }}>
                      {style(selected.group).label}
                    </div>
                    <div className="font-serif text-[1.1rem] leading-snug">{clean(selected.label)}</div>
                  </div>
                  <button onClick={() => setSelected(null)} className="text-mute hover:text-ink" aria-label="Close">
                    <X size={15} />
                  </button>
                </div>
                <div className="max-h-[200px] overflow-y-auto whitespace-pre-line px-4 py-3 text-[12.5px] leading-relaxed text-graphite">
                  {selected.title || selected.label}
                </div>
                {selected.sentiment && SENTIMENT[selected.sentiment] && (
                  <div className="border-t border-rule px-4 py-2.5">
                    <span className={cx("px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.1em]", SENTIMENT[selected.sentiment].cls)}>
                      {SENTIMENT[selected.sentiment].label}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {data.analysis && (
            <section className="mt-10 grid gap-6 border-t border-ink pt-5 lg:grid-cols-[200px_minmax(0,1fr)]">
              <div className="label text-signal">What the graph says</div>
              <p className="max-w-[68ch] whitespace-pre-wrap font-serif text-[16.5px] leading-relaxed">{data.analysis}</p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
