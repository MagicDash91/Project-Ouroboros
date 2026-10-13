"use client";

import { X } from "./icons";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { ReviewRequest } from "@/lib/useRun";
import { Markdown } from "./Markdown";
import { Button, cx } from "./ui";

/* ── Toasts ──────────────────────────────────────────────────────────── */
type ToastTone = "ok" | "warn" | "bad";
interface ToastItem {
  id: number;
  msg: string;
  tone: ToastTone;
}

const ToastCtx = createContext<(msg: string, tone?: ToastTone) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback((msg: string, tone: ToastTone = "ok") => {
    const id = ++seq.current;
    setItems((xs) => [...xs.slice(-3), { id, msg, tone }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[70] flex flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            className="rise pointer-events-auto flex min-w-[260px] max-w-sm items-start gap-3 border border-ink bg-sheet px-4 py-3 text-[13px] shadow-[4px_4px_0_rgb(var(--ink)/0.12)]"
          >
            <span
              className={cx(
                "mt-1.5 h-2 w-2 shrink-0",
                t.tone === "ok" && "bg-moss",
                t.tone === "warn" && "bg-ochre",
                t.tone === "bad" && "bg-signal",
              )}
            />
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ── Lightbox ────────────────────────────────────────────────────────── */
const LightboxCtx = createContext<(src: string, caption?: string) => void>(() => undefined);
export const useLightbox = () => useContext(LightboxCtx);

export function LightboxProvider({ children }: { children: ReactNode }) {
  const [item, setItem] = useState<{ src: string; caption?: string } | null>(null);
  const open = useCallback((src: string, caption?: string) => setItem({ src, caption }), []);
  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setItem(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item]);
  return (
    <LightboxCtx.Provider value={open}>
      {children}
      {item && (
        <div
          className="fixed inset-0 z-[80] flex flex-col items-center justify-center bg-night/90 p-8"
          onClick={() => setItem(null)}
          role="dialog"
          aria-modal="true"
        >
          <button className="absolute right-6 top-5 text-paper/70 hover:text-paper" aria-label="Close">
            <X size={22} />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={item.src} alt={item.caption || ""} className="max-h-[84vh] max-w-[92vw] bg-white" />
          {item.caption && <p className="mt-4 font-mono text-[12px] text-paper/70">{item.caption}</p>}
        </div>
      )}
    </LightboxCtx.Provider>
  );
}

/* ── Plan review (human-in-the-loop) ─────────────────────────────────── */
function useCountdown(deadline: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.round((deadline - now) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

export function ReviewSheet({
  review,
  onDecide,
  onDismiss,
}: {
  review: ReviewRequest;
  onDecide: (abort: boolean) => void;
  onDismiss: () => void;
}) {
  const left = useCountdown(review.deadline);
  return (
    <div className="fixed inset-0 z-[65] flex justify-end bg-ink/25" onClick={onDismiss}>
      <aside
        className="rise flex h-full w-full max-w-[720px] flex-col border-l border-ink bg-paper shadow-[-12px_0_40px_rgb(var(--ink)/0.12)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-title"
      >
        <div className="border-b border-ink px-8 pb-5 pt-7">
          <div className="flex items-start justify-between gap-6">
            <div>
              <div className="label mb-2 text-signal">Stage 2 of 4 · Your review</div>
              <h2 id="review-title" className="font-serif text-[2rem] font-medium leading-tight">
                The strategic plan is ready.
              </h2>
              <p className="mt-2 max-w-md text-[13px] leading-relaxed text-graphite">
                Approve it to let the analytics and marketing teams run, or abort the pipeline here.
              </p>
            </div>
            <button onClick={onDismiss} className="text-[12px] text-mute underline-offset-4 hover:text-ink hover:underline">
              Review later
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-8 py-7">
          {review.report ? <Markdown compact>{review.report}</Markdown> : <p className="text-mute">The planner returned no preview.</p>}
        </div>
        <div className="flex items-center gap-3 border-t border-ink px-8 py-4">
          <p className="mr-auto text-[12px] text-mute">
            Auto-approves in <span className="font-mono text-[13px] text-ink">{left}</span>
          </p>
          <Button tone="quiet" onClick={() => onDecide(true)} className="text-signal hover:text-signal">
            Abort run
          </Button>
          <Button tone="ink" size="lg" onClick={() => onDecide(false)}>
            Approve and continue
          </Button>
        </div>
      </aside>
    </div>
  );
}
