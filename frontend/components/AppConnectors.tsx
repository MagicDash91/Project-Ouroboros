"use client";

import { useEffect, useState } from "react";
import { del, errorText, getJSON, postJSON } from "@/lib/api";
import type { ConnectorStatus, ImportedFile } from "@/lib/types";
import { Button, cx } from "./ui";

/**
 * Bring data in from an app (Google Sheets, Drive, Slack, Notion, Airtable, or a file URL).
 * The backend (features/connectors.py) fetches it and stores it like an upload, so the
 * caller gets back the same file record /api/upload returns.
 */

type Key = ConnectorStatus["key"];
type OAuthState = { name: string; configured: boolean; connected: boolean; account: string; redirect_uri: string };
type Input = { name: string; label: string; placeholder: string; secret?: boolean; width?: string };

const FORMS: Record<Key, { inputs: Input[]; note: string; envNote?: string }> = {
  gsheets: {
    inputs: [{ name: "url", label: "Sheet link", placeholder: "https://docs.google.com/spreadsheets/d/…/edit#gid=0" }],
    note: "Imports the tab in the link. Sheets shared as “Anyone with the link” work as they are.",
    envNote: "Private sheets: share them with the server's Google service account (GOOGLE_APPLICATION_CREDENTIALS).",
  },
  gdrive: {
    inputs: [{ name: "url", label: "File link", placeholder: "https://drive.google.com/file/d/…/view" }],
    note: "CSV, Excel, JSON, Parquet, PDF, Word and PowerPoint files, plus Google Docs, Sheets and Slides.",
    envNote: "Private files: share them with the server's Google service account (GOOGLE_APPLICATION_CREDENTIALS).",
  },
  slack: {
    inputs: [
      { name: "channel", label: "Channel", placeholder: "#sales or a channel link", width: "flex-1" },
      { name: "token", label: "Bot token", placeholder: "xoxb-…", secret: true },
    ],
    note: "Each message becomes a row: time, author, text, replies and reactions. Invite the bot to the channel first.",
  },
  notion: {
    inputs: [
      { name: "url", label: "Database link", placeholder: "https://www.notion.so/…" },
      { name: "token", label: "Integration secret", placeholder: "ntn_… or secret_…", secret: true },
    ],
    note: "Each page in the database becomes a row. Connect your integration to the database (••• → Connections).",
  },
  airtable: {
    inputs: [
      { name: "url", label: "Table link", placeholder: "https://airtable.com/app…/tbl…/viw…" },
      { name: "token", label: "Personal access token", placeholder: "pat…", secret: true },
    ],
    note: "Imports the table, filtered by the view if the link has one. The token needs data.records:read.",
  },
  url: {
    inputs: [{ name: "url", label: "File URL", placeholder: "https://example.com/data/sales.csv" }],
    note: "A direct link to a CSV, Excel, JSON, Parquet, PDF or Word file on the public internet.",
  },
};

const DAYS = [7, 30, 90, 365];

export function AppConnectors({
  onImported,
  tabularOnly = false,
  endpoint = "/api/connectors/import",
}: {
  onImported: (f: ImportedFile) => void;
  tabularOnly?: boolean;
  /** Where the import is stored: the shared upload registry by default, or e.g. a workflow's own files. */
  endpoint?: string;
}) {
  const [list, setList] = useState<ConnectorStatus[]>([]);
  const [active, setActive] = useState<Key>("gsheets");
  const [values, setValues] = useState<Record<string, string>>({});
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [signin, setSignin] = useState<Record<string, OAuthState>>({});
  const loadStatus = () => {
    getJSON<{ connectors: ConnectorStatus[] }>("/api/connectors")
      .then((r) => setList(r.connectors))
      .catch(() => setList([]));
    getJSON<Record<string, OAuthState>>("/api/oauth/status")
      .then(setSignin)
      .catch(() => undefined);
  };

  useEffect(() => {
    loadStatus();
    // The sign-in popup reports back here when it finishes.
    const onMsg = (e: MessageEvent) => {
      if (e.data && e.data.type === "ouro-oauth") loadStatus();
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const provider = active === "gsheets" || active === "gdrive" ? "google" : active === "slack" ? "slack" : "";
  const sign = provider ? signin[provider] : undefined;

  async function connect() {
    if (!provider) return;
    setError("");
    try {
      const r = await getJSON<{ url: string }>(`/api/oauth/${provider}/start`);
      const w = window.open(r.url, "ouro-oauth", "width=520,height=700");
      if (!w) setError("Your browser blocked the sign-in window. Allow pop-ups for this site and try again.");
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function disconnect() {
    if (!provider || !window.confirm(`Disconnect ${sign?.name}? Imports will need a link-shared file or a token again.`)) return;
    await del(`/api/oauth/${provider}`).catch(() => undefined);
    loadStatus();
  }

  const status = list.find((c) => c.key === active);
  const form = FORMS[active];
  // A token the server already has (env var) doesn't need asking for.
  const inputs = form.inputs.filter((i) => !(i.secret && status?.configured));
  const ready = form.inputs.every((i) => (i.secret && status?.configured) || (values[i.name] || "").trim());

  function pick(k: Key) {
    setActive(k);
    setValues({});
    setError("");
  }

  async function run() {
    setBusy(true);
    setError("");
    try {
      const params: Record<string, string> = { ...values, ...(active === "slack" ? { days: String(days) } : {}) };
      const res = await postJSON<ImportedFile>(endpoint, { connector: active, params });
      if (tabularOnly && res.type !== "structured") {
        setError(`${res.filename} is a document. This needs a table; use the document in an Analytics run or an Agent task instead.`);
        return;
      }
      onImported(res);
      setValues((v) => ({ ...v, url: "", channel: "" }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="App">
        {(Object.keys(FORMS) as Key[]).map((k) => {
          const s = list.find((c) => c.key === k);
          return (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={active === k}
              onClick={() => pick(k)}
              title={s?.needs_token && s.configured ? `Token set on the server (${s.env})` : undefined}
              className={cx(
                "rounded-[3px] border px-2.5 py-1 text-[12px] transition-colors",
                active === k ? "border-ink bg-ink text-paper" : "border-rule text-graphite hover:border-ink hover:text-ink",
              )}
            >
              {s?.name ?? k}
              {s?.needs_token && s.configured && <span className={active === k ? "text-paper/60" : "text-moss"}> ●</span>}
            </button>
          );
        })}
      </div>

      {sign && (sign.connected || sign.configured) && (
        <div className="flex flex-wrap items-center gap-2 border border-rule bg-sheet px-2.5 py-1.5 text-[12px]">
          {sign.connected ? (
            <>
              <span className="text-moss">●</span>
              <span className="text-graphite">
                Signed in to {sign.name} as <span className="font-medium text-ink">{sign.account}</span>
              </span>
              <button onClick={disconnect} className="ml-auto text-mute hover:text-signal">
                Disconnect
              </button>
            </>
          ) : (
            <>
              <span className="text-graphite">
                {provider === "google" ? "Import your own private sheets and files:" : "Skip the bot token:"}
              </span>
              <button
                onClick={connect}
                className="ml-auto border border-ink bg-white px-2 py-0.5 font-medium text-ink hover:bg-ink hover:text-paper"
              >
                Connect {sign.name}
              </button>
            </>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2">
        {inputs.map((i) => (
          <label key={i.name} className={cx("block min-w-0", i.width ?? (i.secret ? "w-44" : "w-full"))}>
            <span className="label mb-1 block">{i.label}</span>
            <input
              value={values[i.name] || ""}
              onChange={(e) => setValues((v) => ({ ...v, [i.name]: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && ready && !busy && run()}
              placeholder={i.placeholder}
              type={i.secret ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              className="field w-full font-mono text-[12px]"
            />
          </label>
        ))}
        {active === "slack" && (
          <label className="block">
            <span className="label mb-1 block">History</span>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="field font-mono text-[12px]">
              {DAYS.map((d) => (
                <option key={d} value={d}>
                  {d === 365 ? "1 year" : `${d} days`}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button size="sm" tone="line" onClick={run} disabled={!ready || busy} className="h-[34px]">
          {busy ? "Importing…" : "Import"}
        </Button>
      </div>

      <p className="text-[11.5px] leading-snug text-mute">
        {form.note}
        {status?.needs_token && status.configured && <> Using the server&apos;s {status.env}.</>}
        {status?.needs_token && !status.configured && (
          <> The token is used for this import only and isn&apos;t stored; or set {status.env} on the server.</>
        )}
        {form.envNote && !status?.configured && <> {form.envNote}</>}
      </p>

      {error && <div className="rounded-[3px] border border-signal/40 bg-signal/5 p-2.5 text-[12px] text-graphite">{error}</div>}
    </div>
  );
}
