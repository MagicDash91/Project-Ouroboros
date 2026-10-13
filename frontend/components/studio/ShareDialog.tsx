"use client";

import { useCallback, useEffect, useState } from "react";
import { del, errorText, getJSON, postJSON } from "@/lib/api";
import { Button, cx } from "../ui";

/* Share a deck, document or the Pinboard as a read-only link (optionally expiring, optionally with comments). */

interface ShareComment {
  id: string;
  name: string;
  text: string;
  target: string;
  created_at: string;
}
interface ShareLink {
  token: string;
  title: string;
  created_at: string;
  expires_at: string | null;
  allow_comments: boolean;
  revoked: boolean;
  views: number;
  comment_list: ShareComment[];
}

const EXPIRY = [
  [0, "Never expires"],
  [1, "1 day"],
  [7, "7 days"],
  [30, "30 days"],
  [90, "90 days"],
] as const;

export function ShareButton({ createUrl, listUrl, label = "Share" }: { createUrl: string; listUrl: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" tone="quiet" onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open && <ShareDialog createUrl={createUrl} listUrl={listUrl} onClose={() => setOpen(false)} />}
    </>
  );
}

function ShareDialog({ createUrl, listUrl, onClose }: { createUrl: string; listUrl: string; onClose: () => void }) {
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [hosts, setHosts] = useState<string[]>([]);
  const [expires, setExpires] = useState(0);
  const [comments, setComments] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  const load = useCallback(
    () =>
      getJSON<ShareLink[]>(listUrl)
        .then(setLinks)
        .catch(() => undefined),
    [listUrl],
  );
  useEffect(() => {
    void load();
    getJSON<{ addresses: string[] }>("/api/shares/network")
      .then((r) => setHosts(r.addresses))
      .catch(() => undefined);
  }, [load]);

  const port = typeof window !== "undefined" ? window.location.port : "";
  const here = typeof window !== "undefined" ? window.location.origin : "";
  const urlsFor = (token: string) => [
    { label: "This computer", url: `${here}/share/${token}` },
    ...hosts.map((h) => ({ label: "Same network", url: `${window.location.protocol}//${h}${port ? `:${port}` : ""}/share/${token}` })),
  ];

  async function create() {
    setBusy(true);
    setError("");
    try {
      await postJSON(createUrl, { expires_days: expires, allow_comments: comments });
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      window.prompt("Copy this link:", url);
    }
  }

  const active = links.filter((l) => !l.revoked);
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-night/50 p-4" onClick={onClose}>
      <div
        className="max-h-[88vh] w-full max-w-[680px] overflow-y-auto border border-ink bg-paper p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between">
          <div>
            <div className="label text-signal">Share</div>
            <h3 className="mt-1 font-serif text-[22px] leading-tight text-ink">A read-only link</h3>
            <p className="mt-1 max-w-[56ch] text-[12.5px] leading-relaxed text-graphite">
              Anyone with the link sees the latest saved version (they can&apos;t edit). Turn a link off at any time. The app runs on this
              computer, so links work for people who can reach it: on this computer, or on the same Wi-Fi / office network.
            </p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
            ×
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-y border-rule py-3">
          <select
            value={expires}
            onChange={(e) => setExpires(Number(e.target.value))}
            className="border border-rule bg-white px-2 py-1.5 text-[12.5px]"
          >
            {EXPIRY.map(([d, label]) => (
              <option key={d} value={d}>
                {label}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-[12.5px]">
            <input type="checkbox" checked={comments} onChange={(e) => setComments(e.target.checked)} className="accent-signal" />
            Viewers can comment
          </label>
          <Button size="sm" tone="ink" className="ml-auto" onClick={create} disabled={busy}>
            {busy ? "Creating…" : "Create link"}
          </Button>
        </div>
        {error && <p className="mt-2 text-[12px] text-signal">{error}</p>}

        <div className="mt-4 space-y-3">
          {active.length === 0 && <p className="text-[12.5px] italic text-mute">No active links yet.</p>}
          {active.map((l) => (
            <div key={l.token} className="border border-ink bg-white p-3">
              <div className="mb-2 flex items-center justify-between gap-2 font-mono text-[10.5px] uppercase tracking-[0.08em] text-mute">
                <span>
                  {new Date(l.created_at).toLocaleDateString()} ·{" "}
                  {l.expires_at ? `expires ${new Date(l.expires_at).toLocaleDateString()}` : "no expiry"} · {l.views} view
                  {l.views === 1 ? "" : "s"} ·{" "}
                  {l.allow_comments ? `${l.comment_list.length} comment${l.comment_list.length === 1 ? "" : "s"}` : "comments off"}
                </span>
                <button
                  onClick={async () => {
                    await del(`/api/shares/${l.token}`).catch(() => undefined);
                    await load();
                  }}
                  className="text-graphite hover:text-signal"
                >
                  Turn off
                </button>
              </div>
              <ul className="space-y-1">
                {urlsFor(l.token).map((u) => (
                  <li key={u.url} className="flex items-center gap-2">
                    <span className="w-24 shrink-0 text-[11px] text-mute">{u.label}</span>
                    <code className="min-w-0 flex-1 truncate bg-sheet px-1.5 py-0.5 text-[11.5px]">{u.url}</code>
                    <button
                      onClick={() => copy(u.url)}
                      className={cx("text-[11.5px]", copied === u.url ? "text-moss" : "text-graphite hover:text-ink")}
                    >
                      {copied === u.url ? "Copied ✓" : "Copy"}
                    </button>
                  </li>
                ))}
              </ul>
              {l.comment_list.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-[12px] text-graphite">Comments ({l.comment_list.length})</summary>
                  <ul className="mt-2 space-y-2">
                    {l.comment_list.map((c) => (
                      <li key={c.id} className="border-l-2 border-rule pl-2 text-[12.5px]">
                        <span className="font-medium text-ink">{c.name}</span>
                        <span className="ml-2 font-mono text-[10px] text-mute">
                          {new Date(c.created_at).toLocaleString()}
                          {c.target ? ` · on ${c.target}` : ""}
                        </span>
                        <p className="whitespace-pre-wrap text-graphite">{c.text}</p>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          ))}
        </div>
        {hosts.length > 0 && (
          <p className="mt-4 text-[11px] leading-snug text-mute">
            If someone on your network can&apos;t open it, Windows Firewall may be blocking port {port || "3010"}: allow Node.js on private
            networks.
          </p>
        )}
      </div>
    </div>
  );
}
