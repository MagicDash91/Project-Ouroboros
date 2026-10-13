"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { LogEntry } from "@/lib/types";
import { cx } from "../ui";

type Kind = "error" | "warn" | "ok" | "phase" | "agent" | "plain";

/** Same noise rules as the original console: drop CrewAI table/panel debris and raw JSON. */
function clean(entry: LogEntry): { msg: string; kind: Kind } | null {
  let msg = (entry.message || "").trimEnd();
  if (!msg) return null;
  if ((msg.match(/\|/g) || []).length >= 2) return null;
  if (/^\s*[{}[\]]\s*$/.test(msg)) return null;
  if (/^\s*"[a-zA-Z_]+":\s/.test(msg)) return null;
  if (/^[╭╮╰╯│─═━\s]+$/.test(msg)) return null;
  msg = msg.replace(/[╭╮╰╯│─]+/g, "").trim();
  if (!msg) return null;
  if (msg.length > 300) msg = `${msg.slice(0, 297)}…`;

  let kind: Kind = "plain";
  if (/error|fail|exception|traceback/i.test(msg)) kind = "error";
  else if (/warn/i.test(msg)) kind = "warn";
  else if (/✓|complete|done|saved|success/i.test(msg)) kind = "ok";
  else if (/phase\s+[123]|HUMAN IN THE LOOP/i.test(msg)) kind = "phase";
  else if (/\[(crew|agent|content|marketing|banking|mkt|data)/i.test(msg)) kind = "agent";
  return { msg, kind };
}

const COLOR: Record<Kind, string> = {
  error: "text-[#ff8a6b]",
  warn: "text-[#e6b450]",
  ok: "text-[#9cc79a]",
  phase: "text-paper font-medium",
  agent: "text-[#9fb8d6]",
  plain: "text-paper/60",
};

export function ConsoleView({ logs, running, onClear }: { logs: LogEntry[]; running: boolean; onClear: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const lines = useMemo(() => logs.map((l) => ({ l, c: clean(l) })).filter((x) => x.c), [logs]);

  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length, follow]);

  return (
    <div className="flex h-full flex-col p-6 lg:p-8">
      <div className="mb-3 flex items-end justify-between">
        <div>
          <div className="label text-signal">Live</div>
          <h2 className="font-serif text-[1.6rem] font-medium leading-tight">The wire</h2>
        </div>
        <div className="flex items-center gap-4 text-[12px] text-mute">
          <span className="font-mono">{lines.length.toLocaleString()} lines</span>
          {!follow && (
            <button className="text-ink underline underline-offset-4" onClick={() => setFollow(true)}>
              Jump to latest
            </button>
          )}
          <button className="hover:text-ink" onClick={onClear}>
            Clear
          </button>
        </div>
      </div>

      <div
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
        className="flex-1 overflow-y-auto rounded-[3px] bg-night px-5 py-4 font-mono text-[12px] leading-[1.7] shadow-[inset_0_0_0_1px_rgb(0_0_0/0.4)]"
      >
        {lines.length === 0 ? (
          <p className="text-paper/40">
            {running ? "Waiting for the first agent to report…" : "Nothing on the wire. Write a brief and start a run."}
          </p>
        ) : (
          lines.map(({ l, c }, i) => (
            <div key={i} className={cx("flex gap-4", c!.kind === "phase" && "mt-2")}>
              <span className="shrink-0 select-none text-paper/25">
                {l.timestamp ? new Date(l.timestamp).toLocaleTimeString([], { hour12: false }) : "--:--:--"}
              </span>
              <span className={cx("whitespace-pre-wrap break-words", COLOR[c!.kind])}>{c!.msg}</span>
            </div>
          ))
        )}
        {running && <span className="blink mt-1 inline-block h-3.5 w-2 bg-signal" />}
      </div>
    </div>
  );
}
