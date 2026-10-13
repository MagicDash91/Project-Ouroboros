"use client";

import { useEffect, useState } from "react";
import { errorText, getJSON, postJSON } from "@/lib/api";
import { sendIntent } from "@/lib/intent";
import type { DataChatSession, ImportedFile, UploadedFile } from "@/lib/types";
import { cx } from "./ui";

/* "Start here": ready-made industry kits (fictional sample companies), each handed to every app:
   a Data chat with the kit's metric definitions and questions, an Analytics brief, an Agent goal and
   a ready-made Workflow. The chosen kit and progress are remembered in this browser only. */

type App = "analytics" | "datachat" | "agent" | "workflow";
type StepKey = "chat" | "analytics" | "agent" | "workflow";

interface Kit {
  id: string;
  name: string;
  industry: string;
  tagline: string;
  description: string;
  highlights: string[];
  files: string[];
  metrics: { term: string; definition: string }[];
  questions: string[];
  hints: { chat: string; agent: string; workflow: string };
}

const STEPS: { key: StepKey; app: App; title: string; body: (k: Kit) => string; cta: string; cost: string }[] = [
  {
    key: "chat",
    app: "datachat",
    title: "Ask the data a question",
    body: (k) =>
      `Opens a chat with the kit's metric definitions and six suggested questions, including “why did it change?” and forecasts. ${k.hints.chat}`,
    cta: "Open the sample chat",
    cost: "5 credits per question",
  },
  {
    key: "analytics",
    app: "analytics",
    title: "Run a full analysis",
    body: () => "Fills in an industry brief and attaches the data. You approve the plan; the desk writes the report, dashboard and campaign.",
    cta: "Prepare the analysis",
    cost: "900 credits per run",
  },
  {
    key: "agent",
    app: "agent",
    title: "Let the Agent research",
    body: (k) => `Attaches the data and suggests a goal: ${k.hints.agent}.`,
    cta: "Prepare the task",
    cost: "planning free · 100 credits to run",
  },
  {
    key: "workflow",
    app: "workflow",
    title: "Automate a regular check",
    body: (k) => `Creates a ready-made workflow: ${k.hints.workflow}.`,
    cta: "Create the workflow",
    cost: "2 credits per run (AI step)",
  },
];

const DONE_KEY = "ouro:start-done";
const KIT_KEY = "ouro:start-kit";

function readStore<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

export function StartHere({ onGo }: { onGo: (app: App) => void }) {
  const [kits, setKits] = useState<Kit[]>([]);
  const [kitId, setKitId] = useState("fnb");
  const [busy, setBusy] = useState<StepKey | "">("");
  const [error, setError] = useState("");
  const [done, setDone] = useState<string[]>([]);
  const [details, setDetails] = useState(false);

  useEffect(() => {
    setDone(readStore<string[]>(DONE_KEY, []));
    setKitId(readStore<string>(KIT_KEY, "fnb"));
    getJSON<Kit[]>("/api/kits")
      .then(setKits)
      .catch((e) => setError(errorText(e)));
  }, []);

  const kit = kits.find((k) => k.id === kitId) ?? kits[0];
  // Progress is per kit; older entries without a kit prefix belonged to the coffee sample.
  const isDone = (k: StepKey) => !!kit && (done.includes(`${kit.id}:${k}`) || (kit.id === "fnb" && done.includes(k)));
  const doneCount = STEPS.filter((s) => isDone(s.key)).length;

  const choose = (id: string) => {
    setKitId(id);
    setDetails(false);
    setError("");
    writeStore(KIT_KEY, id);
  };

  const mark = (k: StepKey) => {
    if (!kit) return;
    const next = Array.from(new Set([...done, `${kit.id}:${k}`]));
    setDone(next);
    writeStore(DONE_KEY, next);
  };

  async function start(step: (typeof STEPS)[number]) {
    if (!kit) return;
    setBusy(step.key);
    setError("");
    const base = `/api/kits/${kit.id}`;
    try {
      if (step.key === "chat") {
        const s = await postJSON<DataChatSession>(`${base}/datachat`);
        sendIntent({ type: "open_chat", sid: s.id });
      } else if (step.key === "analytics") {
        const r = await postJSON<{ files: (UploadedFile & { size: number })[]; brief: string }>(`${base}/analytics`);
        sendIntent({ type: "prefill_analysis", request: r.brief, files: r.files });
      } else if (step.key === "agent") {
        const r = await postJSON<{ files: ImportedFile[]; goal: string }>(`${base}/agent`);
        sendIntent({ type: "prefill_agent", goal: r.goal, files: r.files });
      } else {
        const w = await postJSON<{ id: string }>(`${base}/workflow`);
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
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="label text-signal">Start here · no data needed</h2>
            <p className="mt-2 max-w-[62ch] font-serif text-[22px] leading-snug text-ink">
              Try every app on a sample company from your industry.
            </p>
          </div>
          {kit && (
            <span className="font-mono text-[11px] text-mute">
              {doneCount} of {STEPS.length} tried with {kit.name}
            </span>
          )}
        </div>

        <div role="tablist" aria-label="Industry kit" className="mb-4 flex flex-wrap gap-2">
          {kits.map((k) => (
            <button
              key={k.id}
              role="tab"
              aria-selected={k.id === kit?.id}
              onClick={() => choose(k.id)}
              className={cx(
                "border px-3 py-1.5 text-left transition-colors",
                k.id === kit?.id
                  ? "border-ink bg-ink text-paper"
                  : "border-rule bg-white text-graphite hover:border-ink hover:text-ink",
              )}
            >
              <span className="block text-[12.5px] font-medium">{k.industry}</span>
              <span className={cx("block font-mono text-[10px]", k.id === kit?.id ? "text-paper/70" : "text-mute")}>
                {k.name}
              </span>
            </button>
          ))}
        </div>

        {kit && (
          <div className="mb-5 border border-rule bg-white p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="max-w-[90ch] text-[13px] leading-relaxed text-graphite">
                <strong className="font-medium text-ink">{kit.name} (sample)</strong> · {kit.tagline}. {kit.description}
              </p>
              <button
                onClick={() => setDetails((d) => !d)}
                aria-expanded={details}
                className="shrink-0 text-[12px] text-graphite underline-offset-2 hover:text-ink hover:underline"
              >
                {details ? "Hide what's inside" : "What's inside"}
              </button>
            </div>
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-graphite">
              {kit.highlights.map((h) => (
                <li key={h} className="before:mr-1.5 before:text-signal before:content-['•']">
                  {h}
                </li>
              ))}
            </ul>
            {details && (
              <div className="mt-4 grid gap-5 border-t border-rule pt-4 md:grid-cols-2">
                <div>
                  <div className="label mb-1.5">Metric definitions · {kit.metrics.length}</div>
                  <dl className="space-y-1.5 text-[12px] leading-snug">
                    {kit.metrics.map((m) => (
                      <div key={m.term}>
                        <dt className="inline font-medium text-ink">{m.term}: </dt>
                        <dd className="inline text-graphite">{m.definition}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-2 text-[11px] text-mute">Used by the sample chat only; your own glossary is not changed.</p>
                </div>
                <div>
                  <div className="label mb-1.5">Suggested questions · {kit.questions.length}</div>
                  <ol className="list-decimal space-y-1 pl-4 text-[12px] leading-snug text-graphite">
                    {kit.questions.map((q) => (
                      <li key={q}>{q}</li>
                    ))}
                  </ol>
                  <p className="mt-2 font-mono text-[10.5px] text-mute">Files: {kit.files.join(" · ")}</p>
                </div>
              </div>
            )}
          </div>
        )}

        {error && <p className="mb-3 text-[12.5px] text-signal">{error}</p>}
        {kit && (
          <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => {
              const tried = isDone(s.key);
              return (
                <li key={s.key} className={cx("flex flex-col border bg-white p-4", tried ? "border-moss/50" : "border-ink")}>
                  <span className={cx("font-mono text-[10.5px] uppercase tracking-[0.1em]", tried ? "text-moss" : "text-mute")}>
                    {tried ? "✓ Tried" : `Step ${i + 1}`}
                  </span>
                  <h3 className="mt-1 text-[15px] font-semibold leading-snug text-ink">{s.title}</h3>
                  <p className="mt-1.5 flex-1 text-[12.5px] leading-relaxed text-graphite">{s.body(kit)}</p>
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
        )}
      </div>
    </section>
  );
}
