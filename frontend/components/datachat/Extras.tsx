"use client";

import { useEffect, useState } from "react";
import { errorText, getJSON, putJSON } from "@/lib/api";
import type { DataChatOverview, GlossaryTerm } from "@/lib/types";
import { Button, cx } from "../ui";

/* Data chat helpers: the data overview with suggested questions, follow-up chips, and the shared glossary. */

const fmtRows = (n: number | null) => (n == null ? "database table" : `${n.toLocaleString()} rows`);

export function OverviewCard({
  ov,
  loading,
  error,
  onAsk,
  compact = false,
}: {
  ov?: DataChatOverview;
  loading: boolean;
  error?: string;
  onAsk: (q: string) => void;
  compact?: boolean;
}) {
  if (loading && !ov)
    return (
      <div className="mb-8 border border-rule bg-sheet px-5 py-4 text-[13px] text-mute">
        <span className="blink mr-2 inline-block h-1.5 w-1.5 rounded-full bg-signal align-middle" />
        Profiling your data and preparing suggested questions…
      </div>
    );
  if (!ov) return error ? <p className="mb-6 text-[12px] text-mute">Overview unavailable: {error}</p> : null;

  const body = (
    <>
      {ov.summary && <p className="text-[14px] leading-relaxed text-ink">{ov.summary}</p>}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {ov.tables.map((t) => (
          <span key={t.name} className="border border-rule bg-white px-2 py-0.5 font-mono text-[10.5px] text-graphite">
            {t.name} · {fmtRows(t.rows)} · {t.columns} cols
            {t.dates.map((d) => ` · ${d.column} ${d.from} → ${d.to}`).join("")}
          </span>
        ))}
      </div>
      {ov.issues.length > 0 && (
        <ul className="mt-3 space-y-1 border-l-2 border-ochre pl-3 text-[12.5px] leading-snug text-graphite">
          {ov.issues.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}
      {ov.questions.length > 0 && (
        <div className="mt-4">
          <div className="label mb-1.5">Suggested questions</div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {ov.questions.map((q) => (
              <button
                key={q}
                onClick={() => onAsk(q)}
                className="border border-rule bg-white px-3 py-2 text-left text-[13px] leading-snug text-graphite transition-colors hover:border-ink hover:text-ink"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );

  if (compact)
    return (
      <details className="group mb-8 border border-rule bg-sheet px-5 py-3">
        <summary className="flex cursor-pointer list-none items-center justify-between text-[12.5px] text-graphite">
          <span>
            <span className="label mr-2">Data overview</span>
            {ov.tables.map((t) => `${t.name} · ${fmtRows(t.rows)}`).join(" · ")}
          </span>
          <span className="text-mute transition-transform group-open:rotate-180">▾</span>
        </summary>
        <div className="mt-3">{body}</div>
      </details>
    );
  return (
    <section className="mb-8 border border-ink bg-sheet px-5 py-4">
      <div className="label mb-2 text-signal">Data overview</div>
      {body}
    </section>
  );
}

export function Followups({ items, onAsk, disabled }: { items?: string[]; onAsk: (q: string) => void; disabled?: boolean }) {
  if (!items?.length) return null;
  return (
    <div className="mt-4 flex flex-wrap gap-1.5">
      {items.map((q) => (
        <button
          key={q}
          disabled={disabled}
          onClick={() => onAsk(q)}
          className="border border-rule bg-white px-2.5 py-1 text-left text-[12.5px] text-graphite transition-colors hover:border-signal hover:text-ink disabled:opacity-40"
        >
          {q} →
        </button>
      ))}
    </div>
  );
}

/** Shared business definitions the analyst applies in every chat ("active customer = …"). */
export function GlossaryPanel() {
  const [terms, setTerms] = useState<GlossaryTerm[]>([]);
  const [draft, setDraft] = useState<GlossaryTerm[] | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getJSON<{ terms: GlossaryTerm[] }>("/api/datachat/glossary")
      .then((r) => setTerms(r.terms))
      .catch(() => undefined);
  }, []);

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError("");
    try {
      const r = await putJSON<{ terms: GlossaryTerm[] }>("/api/datachat/glossary", {
        terms: draft.filter((t) => t.term.trim() && t.definition.trim()),
      });
      setTerms(r.terms);
      setDraft(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  const field = "w-full border border-rule bg-white px-2 py-1 text-[12px] focus:border-ink focus:outline-none";
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="label">Glossary · {terms.length}</span>
        {!draft && (
          <button
            onClick={() => setDraft(terms.length ? terms.map((t) => ({ ...t })) : [{ term: "", definition: "" }])}
            className="text-[11.5px] text-graphite underline-offset-2 hover:text-ink hover:underline"
          >
            {terms.length ? "Edit" : "Add"}
          </button>
        )}
      </div>
      {!draft ? (
        terms.length === 0 ? (
          <p className="text-[11.5px] leading-snug text-mute">
            Define your business terms once (e.g. <em>active customer</em> = ordered in the last 90 days) and every answer uses them.
          </p>
        ) : (
          <dl className="space-y-1.5 text-[11.5px] leading-snug">
            {terms.map((t) => (
              <div key={t.term}>
                <dt className="font-medium text-ink">{t.term}</dt>
                <dd className="text-graphite">{t.definition}</dd>
              </div>
            ))}
          </dl>
        )
      ) : (
        <div className="space-y-2">
          {draft.map((t, i) => (
            <div key={i} className="space-y-1 border-b border-rule pb-2">
              <div className="flex gap-1">
                <input
                  value={t.term}
                  placeholder="Term"
                  onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, term: e.target.value } : x)))}
                  className={cx(field, "font-medium")}
                />
                <button
                  onClick={() => setDraft(draft.filter((_, j) => j !== i))}
                  className="px-1 text-mute hover:text-signal"
                  aria-label="Remove term"
                >
                  ×
                </button>
              </div>
              <textarea
                value={t.definition}
                rows={2}
                placeholder="What it means, e.g. ordered in the last 90 days"
                onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, definition: e.target.value } : x)))}
                className={cx(field, "resize-none")}
              />
            </div>
          ))}
          <button
            onClick={() => setDraft([...draft, { term: "", definition: "" }])}
            className="text-[11.5px] text-graphite hover:text-signal"
          >
            + Add term
          </button>
          {error && <p className="text-[11.5px] text-signal">{error}</p>}
          <div className="flex gap-1.5">
            <Button size="sm" tone="ink" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              size="sm"
              tone="quiet"
              onClick={() => {
                setDraft(null);
                setError("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
