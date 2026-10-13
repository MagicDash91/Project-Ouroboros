"use client";

import { useEffect, useState } from "react";
import { errorText, getJSON, postJSON } from "@/lib/api";
import { sendIntent } from "@/lib/intent";
import type { DataChatSession, ImportedFile, UploadedFile } from "@/lib/types";
import { cx } from "./ui";

/* "Start here": a guided first run on the fictional Kopi Nusantara sample, one step per app.
   Progress is remembered in this browser only (a convenience, not stored on the server). */

type App = "analytics" | "datachat" | "agent" | "workflow";
type StepKey = "chat" | "analytics" | "agent" | "workflow";

const STEPS: { key: StepKey; app: App; title: string; body: string; cta: string; cost: string }[] = [
  {
    key: "chat",
    app: "datachat",
    title: "Ask the data a question",
    body: "Opens a chat on the sample with a data overview and suggested questions. Try: “How did Ramadan change sales by channel?”",
    cta: "Open the sample chat",
    cost: "5 credits per question",
  },
  {
    key: "analytics",
    app: "analytics",
    title: "Run a full analysis",
    body: "Fills in a brief and attaches the sample. You approve the plan; the desk writes the report, dashboard and campaign.",
    cta: "Prepare the analysis",
    cost: "900 credits per run",
  },
  {
    key: "agent",
    app: "agent",
    title: "Let the Agent research",
    body: "Attaches the sample and suggests a goal: compare our menu prices with Kopi Kenangan, Fore and Janji Jiwa online.",
    cta: "Prepare the task",
    cost: "planning free · 100 credits to run",
  },
  {
    key: "workflow",
    app: "workflow",
    title: "Automate a weekly check",
    body: "Creates a ready-made workflow: quality check, monthly revenue by channel, growth, a chart, AI insights and an Excel export.",
    cta: "Create the workflow",
    cost: "2 credits per run (AI step)",
  },
];

const DONE_KEY = "ouro:start-done";

export function StartHere({ onGo }: { onGo: (app: App) => void }) {
  const [info, setInfo] = useState<{ name: string; orders: number; description: string } | null>(null);
  const [busy, setBusy] = useState<StepKey | "">("");
  const [error, setError] = useState("");
  const [done, setDone] = useState<StepKey[]>([]);

  useEffect(() => {
    try {
      setDone(JSON.parse(localStorage.getItem(DONE_KEY) || "[]"));
    } catch {
      setDone([]);
    }
    getJSON<{ name: string; orders: number; description: string }>("/api/samples")
      .then(setInfo)
      .catch(() => undefined);
  }, []);

  const mark = (k: StepKey) => {
    const next = Array.from(new Set([...done, k]));
    setDone(next);
    try {
      localStorage.setItem(DONE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  };

  async function start(step: (typeof STEPS)[number]) {
    setBusy(step.key);
    setError("");
    try {
      if (step.key === "chat") {
        const s = await postJSON<DataChatSession>("/api/samples/datachat");
        sendIntent({ type: "open_chat", sid: s.id });
      } else if (step.key === "analytics") {
        const r = await postJSON<{ files: (UploadedFile & { size: number })[]; brief: string }>("/api/samples/analytics");
        sendIntent({ type: "prefill_analysis", request: r.brief, files: r.files });
      } else if (step.key === "agent") {
        const r = await postJSON<{ files: ImportedFile[]; goal: string }>("/api/samples/agent");
        sendIntent({ type: "prefill_agent", goal: r.goal, files: r.files });
      } else {
        const w = await postJSON<{ id: string }>("/api/samples/workflow");
        sendIntent({ type: "open_workflow", id: w.id });
      }
      mark(step.key);
      onGo(step.app);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="border-b border-rule bg-sheet">
      <div className="mx-auto max-w-[1180px] px-6 py-10 lg:px-10">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="label text-signal">Start here · no data needed</h2>
            <p className="mt-2 max-w-[62ch] font-serif text-[22px] leading-snug text-ink">Try every app on a sample company first.</p>
            <p className="mt-1 max-w-[70ch] text-[13px] leading-relaxed text-graphite">
              <strong className="font-medium text-ink">{info?.name ?? "Kopi Nusantara (sample)"}</strong>:{" "}
              {info?.description ?? "a fictional Indonesian coffee & snacks chain."}
              {info ? ` ${info.orders.toLocaleString()} orders, with Ramadan, 11.11 and 12.12 effects to discover.` : ""}
            </p>
          </div>
          <span className="font-mono text-[11px] text-mute">
            {done.length} of {STEPS.length} tried
          </span>
        </div>
        {error && <p className="mb-3 text-[12.5px] text-signal">{error}</p>}
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => {
            const isDone = done.includes(s.key);
            return (
              <li key={s.key} className={cx("flex flex-col border bg-white p-4", isDone ? "border-moss/50" : "border-ink")}>
                <span className={cx("font-mono text-[10.5px] uppercase tracking-[0.1em]", isDone ? "text-moss" : "text-mute")}>
                  {isDone ? "✓ Tried" : `Step ${i + 1}`}
                </span>
                <h3 className="mt-1 text-[15px] font-semibold leading-snug text-ink">{s.title}</h3>
                <p className="mt-1.5 flex-1 text-[12.5px] leading-relaxed text-graphite">{s.body}</p>
                <button
                  onClick={() => start(s)}
                  disabled={!!busy}
                  className="mt-3 border border-ink bg-ink px-3 py-2 text-left text-[12.5px] font-medium text-paper transition-colors hover:border-signal hover:bg-signal disabled:opacity-50"
                >
                  {busy === s.key ? "Preparing…" : `${s.cta} →`}
                </button>
                <span className="mt-1.5 font-mono text-[10px] text-mute">{s.cost}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
