"use client";

import type { PhaseKey, PhaseState, RunStatus } from "@/lib/types";
import { cx } from "./ui";

const STEPS: { key: PhaseKey; name: string; who: string }[] = [
  { key: "plan", name: "Plan", who: "LangGraph planner" },
  { key: "review", name: "Review", who: "You" },
  { key: "analytics", name: "Analytics", who: "Engineer · Scientist · Analyst · CDO" },
  { key: "marketing", name: "Marketing", who: "Researcher · Planner · Content · CMO" },
];

const STATUS_TEXT: Record<RunStatus, string> = {
  idle: "No run yet",
  running: "Running",
  awaiting: "Waiting for your review",
  completed: "Finished",
  error: "Failed",
  aborted: "Aborted",
};

export function Masthead({
  status,
  phases,
  taskId,
  startedAt,
  reviewPending,
  onOpenReview,
}: {
  status: RunStatus;
  phases: Record<PhaseKey, PhaseState>;
  taskId: string | null;
  startedAt: string | null;
  reviewPending: boolean;
  onOpenReview: () => void;
}) {
  return (
    <header className="border-b border-ink bg-paper">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3 px-6 pb-3 pt-5 lg:px-8">
        <div className="flex items-baseline gap-4">
          <h1 className="font-serif text-[1.9rem] font-medium leading-none tracking-[-0.02em]">
            Ouroboros
          </h1>
          <span className="hidden font-serif text-[1.05rem] italic text-mute sm:inline">
            an analytics &amp; marketing desk, staffed by agents
          </span>
        </div>
        <div className="flex items-center gap-5 text-[12px]">
          {reviewPending && (
            <button onClick={onOpenReview} className="bg-signal px-3 py-1.5 font-medium text-white hover:bg-ink">
              Review the plan
            </button>
          )}
          <span className="flex items-center gap-2">
            <span
              className={cx(
                "h-2 w-2",
                status === "running" && "blink bg-signal",
                status === "awaiting" && "blink bg-ochre",
                status === "completed" && "bg-moss",
                (status === "error" || status === "aborted") && "bg-signal",
                status === "idle" && "border border-mute",
              )}
            />
            <span className="font-medium">{STATUS_TEXT[status]}</span>
          </span>
          {taskId && (
            <span className="hidden font-mono text-mute md:inline" title={taskId}>
              run {taskId.slice(0, 8)}
              {startedAt && ` · ${new Date(startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
            </span>
          )}
        </div>
      </div>

      {/* Pipeline tracker: four columns that fill as the backend reports each phase. */}
      <ol className="grid grid-cols-2 border-t border-rule md:grid-cols-4">
        {STEPS.map((s, i) => {
          const state = phases[s.key];
          return (
            <li
              key={s.key}
              className={cx(
                "relative overflow-hidden border-rule px-6 py-2.5 lg:px-8",
                i > 0 && "md:border-l",
                i % 2 === 1 && "border-l md:border-l",
                i > 1 && "border-t md:border-t-0",
                state === "skipped" && "opacity-45",
              )}
            >
              <div className="flex items-baseline gap-2.5">
                <span
                  className={cx(
                    "font-mono text-[11px]",
                    state === "done" ? "text-moss" : state === "active" ? "text-signal" : "text-mute",
                  )}
                >
                  {state === "done" ? "✓" : String(i + 1).padStart(2, "0")}
                </span>
                <span className={cx("text-[13px] font-medium", state === "pending" && "text-mute")}>{s.name}</span>
                {state === "skipped" && <span className="text-[11px] text-mute">skipped</span>}
              </div>
              <div className="mt-0.5 truncate pl-[26px] text-[11px] text-mute">{s.who}</div>
              <span
                className={cx(
                  "absolute bottom-0 left-0 h-[3px] transition-[width,background-color] duration-700",
                  state === "done" && "w-full bg-ink",
                  state === "active" && "sweep w-full bg-signal/15",
                  (state === "pending" || state === "skipped") && "w-0",
                )}
              />
            </li>
          );
        })}
      </ol>
    </header>
  );
}
