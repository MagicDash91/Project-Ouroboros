"use client";

import { useEffect, useRef, useState } from "react";
import { errorText, getJSON, postJSON } from "@/lib/api";
import type { ChatTurn } from "@/lib/types";
import { Send } from "../icons";
import { Markdown } from "../Markdown";
import { useLightbox } from "../Overlays";
import { Empty, Working, cx } from "../ui";

const SUGGESTIONS = [
  "What are the three biggest risks in this data?",
  "Show me a chart of churn by contract type",
  "Which customer segment should marketing target first?",
];

interface HistoryItem {
  user: string;
  assistant: string;
  chart_urls?: string[];
}

export function ChatView({ taskId, ready }: { taskId: string | null; ready: boolean }) {
  const lightbox = useLightbox();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!taskId || !ready) return;
    getJSON<{ history: HistoryItem[] }>(`/api/chat/history/${taskId}`)
      .then((r) =>
        setTurns(
          r.history.flatMap((h) => [
            { role: "user" as const, text: h.user },
            { role: "assistant" as const, text: h.assistant, charts: h.chart_urls },
          ]),
        ),
      )
      .catch(() => setTurns([]));
  }, [taskId, ready]);

  // Block body on purpose: whatever an effect returns is treated as its cleanup, and
  // scroll methods may return a value (a Promise in newer browsers), which crashes
  // React on unmount with "destroy is not a function".
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length, sending]);

  async function send(text: string) {
    const msg = text.trim();
    if (!msg || !taskId || sending) return;
    setDraft("");
    setTurns((t) => [...t, { role: "user", text: msg }]);
    setSending(true);
    try {
      const r = await postJSON<{ reply: string; chart_urls?: string[]; security_flags?: string[] }>(`/api/chat/${taskId}`, {
        message: msg,
      });
      setTurns((t) => [...t, { role: "assistant", text: r.reply, charts: r.chart_urls, flags: r.security_flags }]);
    } catch (e) {
      setTurns((t) => [...t, { role: "assistant", text: errorText(e), error: true }]);
    } finally {
      setSending(false);
    }
  }

  if (!ready) {
    return (
      <div className="mx-auto max-w-[820px] px-6 py-10 lg:px-10">
        <Empty title="Questions open once a run finishes.">
          The desk answers from that run&apos;s data and reports, and can draw new charts on request.
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[820px] px-6 py-10 lg:px-10">
          <header className="mb-8 border-b border-ink pb-4">
            <div className="label mb-2 text-signal">Ask the desk</div>
            <h2 className="font-serif text-[2rem] font-medium leading-tight">Questions about this run</h2>
            <p className="mt-2 text-[12px] text-mute">
              Inputs and outputs are screened: PII redaction, SQL-injection guard, scope guardrails, and an audit log.
            </p>
          </header>

          {turns.length === 0 && (
            <div className="space-y-2">
              <p className="mb-3 font-serif text-[1.15rem] italic text-graphite">Try one of these, or ask your own.</p>
              {SUGGESTIONS.map((s) => (
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

          <div className="space-y-8">
            {turns.map((t, i) => (
              <div key={i} className="rise grid grid-cols-[72px_minmax(0,1fr)] gap-4">
                <div className={cx("pt-1 font-mono text-[11px] uppercase tracking-[0.08em]", t.role === "user" ? "text-mute" : "text-signal")}>
                  {t.role === "user" ? "You" : "Desk"}
                </div>
                <div className="min-w-0">
                  {t.role === "user" ? (
                    <p className="whitespace-pre-wrap text-[14.5px] font-medium leading-relaxed">{t.text}</p>
                  ) : t.error ? (
                    <p className="text-[14px] text-signal">{t.text}</p>
                  ) : (
                    <Markdown compact>{t.text}</Markdown>
                  )}
                  {t.charts?.map((src) => (
                    <button key={src} onClick={() => lightbox(src)} className="mt-4 block cursor-zoom-in border border-rule bg-white p-1.5 hover:border-ink">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={src} alt="Generated chart" className="max-h-[360px]" />
                    </button>
                  ))}
                  {t.flags && t.flags.length > 0 && (
                    <p className="mt-2 font-mono text-[10.5px] uppercase tracking-[0.08em] text-ochre">
                      {t.flags.map((f) => f.replace(/_/g, " ")).join(" · ")}
                    </p>
                  )}
                </div>
              </div>
            ))}
            {sending && (
              <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-4">
                <div className="pt-1 font-mono text-[11px] uppercase tracking-[0.08em] text-signal">Desk</div>
                <Working label="Looking into it" />
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
        <div className="mx-auto flex max-w-[820px] items-end gap-3 px-6 py-4 lg:px-10">
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
            maxLength={2000}
            placeholder="Ask a question, or ask for a chart…"
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
    </div>
  );
}
