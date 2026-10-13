"use client";

import { useCallback, useEffect, useState } from "react";
import { Present, SlideCanvas } from "@/components/studio/DeckEditor";
import { BlockView } from "@/components/studio/DocEditor";
import { brandVars, type BrandKit } from "@/components/studio/brand";
import type { Deck, Doc } from "@/components/studio/shared";
import { Chart, ResultTable } from "@/components/views/DataChatView";
import { errorText, getJSON, postJSON } from "@/lib/api";
import type { DataChatPin } from "@/lib/types";

/* Public, read-only view of a shared deck, document or Pinboard (/share/<token>). */

interface ShareComment {
  id: string;
  name: string;
  text: string;
  target: string;
  created_at: string;
}
interface ShareView {
  type: "deck" | "doc" | "pinboard";
  title: string;
  allow_comments: boolean;
  comments: ShareComment[];
  expires_at: string | null;
  data?: Deck | Doc;
  brand?: BrandKit;
  pins?: DataChatPin[];
}

const NAME_KEY = "ouro:share-name";

export default function SharePage({ params }: { params: { token: string } }) {
  const [view, setView] = useState<ShareView | null>(null);
  const [error, setError] = useState("");
  const [presenting, setPresenting] = useState<number | null>(null);
  const [target, setTarget] = useState("");

  const load = useCallback(
    () =>
      getJSON<ShareView>(`/api/share/${params.token}`)
        .then(setView)
        .catch((e) => setError(errorText(e))),
    [params.token],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (error)
    return (
      <main className="grid min-h-screen place-items-center bg-paper px-6 text-center">
        <div>
          <div className="label text-signal">Ouroboros</div>
          <h1 className="mt-2 font-serif text-[28px] text-ink">This link can&apos;t be opened</h1>
          <p className="mt-2 text-[14px] text-graphite">{error}</p>
        </div>
      </main>
    );
  if (!view) return <main className="grid min-h-screen place-items-center bg-paper text-[13px] text-mute">Loading…</main>;

  const deck = view.type === "deck" ? (view.data as Deck) : null;
  const doc = view.type === "doc" ? (view.data as Doc) : null;
  return (
    <main className="min-h-screen bg-sheet">
      <header className="border-b border-ink bg-paper">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-3 px-6 py-3">
          <span className="font-serif text-[18px] text-ink">Ouroboros</span>
          <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-mute">
            Shared {view.type === "pinboard" ? "pinboard" : view.type === "deck" ? "deck" : "document"} · read-only
            {view.expires_at ? ` · until ${new Date(view.expires_at).toLocaleDateString()}` : ""}
          </span>
          {deck && deck.slides.length > 0 && (
            <button
              onClick={() => setPresenting(0)}
              className="ml-auto border border-signal bg-signal px-3 py-1.5 text-[12.5px] font-medium text-white"
            >
              ▶ Present
            </button>
          )}
        </div>
      </header>

      <div className="mx-auto grid max-w-[1200px] gap-8 px-6 py-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section className="min-w-0">
          <h1 className="mb-6 font-serif text-[30px] leading-tight text-ink">{view.title}</h1>

          {deck && (
            <ol className="space-y-6">
              {deck.slides.map((s, i) => (
                <li key={s.id}>
                  <div className="shadow-[0_14px_30px_-16px_rgb(var(--ink)/0.4)] ring-1 ring-ink/60">
                    <SlideCanvas slide={s} n={i + 1} brand={view.brand} />
                  </div>
                  <div className="mt-1.5 flex gap-3 text-[11.5px] text-mute">
                    <button onClick={() => setPresenting(i)} className="hover:text-ink">
                      Present from here
                    </button>
                    {view.allow_comments && (
                      <button onClick={() => setTarget(`slide ${i + 1}`)} className="hover:text-ink">
                        Comment on this slide
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}

          {doc && (
            <article
              style={{ ...brandVars(view.brand), ...(view.brand && !view.brand.builtin ? { background: view.brand.background } : {}) }}
              className="bg-white px-10 py-10 ring-1 ring-rule"
            >
              {view.brand?.logo && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={view.brand.logo} alt="" className="mb-6 h-10 w-auto" />
              )}
              <div className="space-y-3">
                {doc.blocks.map((b) => (
                  <BlockView key={b.id} b={b} editable={false} onChange={() => undefined} />
                ))}
              </div>
              {view.brand?.footer && <p className="mt-6 border-t border-rule pt-2 font-sans text-[11px] text-mute">{view.brand.footer}</p>}
            </article>
          )}

          {view.type === "pinboard" && (
            <div className="grid gap-5 md:grid-cols-2">
              {(view.pins ?? []).map((p) => (
                <article key={p.id} className="min-w-0 border border-ink bg-white p-4">
                  <h3 className="text-[13.5px] font-medium leading-snug text-ink">{p.question || "Pinned result"}</h3>
                  <p className="mb-2 mt-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
                    {p.chat} ·{" "}
                    {p.refreshed_at
                      ? `updated ${new Date(p.refreshed_at).toLocaleString()}`
                      : `pinned ${new Date(p.created_at).toLocaleDateString()}`}
                  </p>
                  {p.kind === "chart" && p.chart && <Chart url={p.chart.url} kind={p.chart.kind} />}
                  {p.kind === "table" && p.table && <ResultTable t={p.table} />}
                </article>
              ))}
              {(view.pins ?? []).length === 0 && <p className="text-[13px] italic text-mute">The pinboard is empty.</p>}
            </div>
          )}
        </section>

        {view.allow_comments && (
          <Comments token={params.token} comments={view.comments} target={target} setTarget={setTarget} onPosted={load} />
        )}
      </div>

      {deck && presenting !== null && (
        <Present slides={deck.slides} start={presenting} brand={view.brand} onClose={() => setPresenting(null)} />
      )}
    </main>
  );
}

function Comments({
  token,
  comments,
  target,
  setTarget,
  onPosted,
}: {
  token: string;
  comments: ShareComment[];
  target: string;
  setTarget: (t: string) => void;
  onPosted: () => void;
}) {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    try {
      setName(localStorage.getItem(NAME_KEY) || "");
    } catch {
      // ignore
    }
  }, []);

  async function post() {
    setBusy(true);
    setError("");
    try {
      await postJSON(`/api/share/${token}/comments`, { name, text, target });
      try {
        localStorage.setItem(NAME_KEY, name);
      } catch {
        // ignore
      }
      setText("");
      setTarget("");
      onPosted();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const field = "w-full border border-rule bg-white px-2.5 py-1.5 text-[13px] focus:border-ink focus:outline-none";
  return (
    <aside className="lg:sticky lg:top-6 lg:self-start">
      <div className="label mb-2">Comments · {comments.length}</div>
      <ul className="mb-4 max-h-[50vh] space-y-3 overflow-y-auto">
        {comments.map((c) => (
          <li key={c.id} className="border-l-2 border-rule pl-2.5">
            <div className="text-[12.5px] font-medium text-ink">
              {c.name}
              {c.target && <span className="ml-1.5 font-mono text-[10px] font-normal text-mute">on {c.target}</span>}
            </div>
            <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-graphite">{c.text}</p>
            <div className="font-mono text-[10px] text-mute">{new Date(c.created_at).toLocaleString()}</div>
          </li>
        ))}
        {comments.length === 0 && <li className="text-[12px] italic text-mute">No comments yet.</li>}
      </ul>
      <div className="space-y-2 border-t border-rule pt-3">
        {target && (
          <div className="flex items-center justify-between text-[11.5px] text-graphite">
            <span>Commenting on {target}</span>
            <button onClick={() => setTarget("")} className="text-mute hover:text-ink">
              ×
            </button>
          </div>
        )}
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" maxLength={60} className={field} />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a comment"
          rows={3}
          maxLength={1000}
          className={`${field} resize-none`}
        />
        {error && <p className="text-[12px] text-signal">{error}</p>}
        <button
          onClick={post}
          disabled={busy || !name.trim() || !text.trim()}
          className="w-full bg-ink px-3 py-2 text-[12.5px] font-medium text-paper hover:bg-signal disabled:opacity-40"
        >
          {busy ? "Posting…" : "Post comment"}
        </button>
      </div>
    </aside>
  );
}
