"use client";

// Snowflake / BigQuery helper: fill a few fields, get a working connection string.
// BigQuery keys are uploaded once to the server (/api/connectors/bigquery-key) and referenced as ?key=<id>,
// so the key itself is never pasted into a form or sent back to the browser.

import { useState } from "react";
import { errorText, postForm } from "@/lib/api";
import { cx } from "@/components/ui";

const input = "w-full border border-rule bg-white px-2 py-1 font-mono text-[12px] outline-none focus:border-ink";
const enc = encodeURIComponent;

export function WarehouseConnect({ onUri, className }: { onUri: (uri: string) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"snowflake" | "bigquery">("snowflake");
  const [sf, setSf] = useState({ account: "", user: "", password: "", warehouse: "", database: "", schema: "", role: "" });
  const [bq, setBq] = useState({ key_id: "", email: "", project: "", dataset: "", location: "" });
  const [msg, setMsg] = useState("");

  const uploadKey = async (f: File | undefined) => {
    if (!f) return;
    setMsg("Uploading key…");
    const form = new FormData();
    form.append("file", f);
    try {
      const r = await postForm<{ key_id: string; project_id: string; client_email: string }>("/api/connectors/bigquery-key", form);
      setBq((b) => ({ ...b, key_id: r.key_id, email: r.client_email, project: b.project || r.project_id }));
      setMsg("");
    } catch (e) { setMsg(errorText(e)); }
  };

  const sfReady = !!(sf.account && sf.user && sf.password && sf.database);
  const bqReady = !!(bq.key_id && bq.project);
  const build = () => {
    if (kind === "snowflake") {
      const acct = sf.account.trim().replace(/^https?:\/\//, "").replace(/\.snowflakecomputing\.com.*$/, "");
      const path = [sf.database.trim(), sf.schema.trim()].filter(Boolean).map(enc).join("/");
      const q = [sf.warehouse && `warehouse=${enc(sf.warehouse.trim())}`, sf.role && `role=${enc(sf.role.trim())}`].filter(Boolean).join("&");
      onUri(`snowflake://${enc(sf.user.trim())}:${enc(sf.password)}@${acct}/${path}${q ? `?${q}` : ""}`);
    } else {
      const q = [`key=${bq.key_id}`, bq.location && `location=${enc(bq.location.trim())}`].filter(Boolean).join("&");
      onUri(`bigquery://${enc(bq.project.trim())}${bq.dataset.trim() ? `/${enc(bq.dataset.trim())}` : ""}?${q}`);
    }
    setOpen(false);
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className={cx("text-[11.5px] text-graphite underline decoration-rule underline-offset-2 hover:text-ink", className)}>
        Connect Snowflake or BigQuery with a form
      </button>
    );
  }
  return (
    <div className={cx("border border-rule bg-white p-3", className)}>
      <div className="flex items-center gap-4 border-b border-rule pb-2 text-[12.5px]">
        {(["snowflake", "bigquery"] as const).map((k) => (
          <button key={k} type="button" onClick={() => setKind(k)} className={cx(kind === k ? "font-semibold text-ink" : "text-graphite hover:text-ink")}>
            {k === "snowflake" ? "Snowflake" : "BigQuery"}
          </button>
        ))}
        <button type="button" onClick={() => setOpen(false)} className="ml-auto text-[11.5px] text-mute hover:text-ink">Close</button>
      </div>
      {kind === "snowflake" ? (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="text-[11px] text-graphite">Account identifier
            <input className={input} placeholder="orgname-accountname" value={sf.account} onChange={(e) => setSf({ ...sf, account: e.target.value })} /></label>
          <label className="text-[11px] text-graphite">Warehouse
            <input className={input} placeholder="COMPUTE_WH" value={sf.warehouse} onChange={(e) => setSf({ ...sf, warehouse: e.target.value })} /></label>
          <label className="text-[11px] text-graphite">User
            <input className={input} autoComplete="off" value={sf.user} onChange={(e) => setSf({ ...sf, user: e.target.value })} /></label>
          <label className="text-[11px] text-graphite">Password
            <input className={input} type="password" autoComplete="new-password" value={sf.password} onChange={(e) => setSf({ ...sf, password: e.target.value })} /></label>
          <label className="text-[11px] text-graphite">Database
            <input className={input} value={sf.database} onChange={(e) => setSf({ ...sf, database: e.target.value })} /></label>
          <label className="text-[11px] text-graphite">Schema
            <input className={input} placeholder="PUBLIC" value={sf.schema} onChange={(e) => setSf({ ...sf, schema: e.target.value })} /></label>
          <label className="text-[11px] text-graphite">Role (optional)
            <input className={input} placeholder="A role that can only SELECT" value={sf.role} onChange={(e) => setSf({ ...sf, role: e.target.value })} /></label>
          <p className="self-end text-[11px] text-mute">Use a read-only role. Each query stops after 60 seconds.</p>
        </div>
      ) : (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="text-[11px] text-graphite sm:col-span-2">Service-account key (JSON)
            <input type="file" accept=".json,application/json" className="mt-0.5 block text-[12px]" onChange={(e) => uploadKey(e.target.files?.[0])} />
            {bq.email && <span className="mt-0.5 block font-mono text-[11px] text-ink">✓ {bq.email}</span>}
          </label>
          <label className="text-[11px] text-graphite">Project
            <input className={input} value={bq.project} onChange={(e) => setBq({ ...bq, project: e.target.value })} /></label>
          <label className="text-[11px] text-graphite">Dataset
            <input className={input} placeholder="sales" value={bq.dataset} onChange={(e) => setBq({ ...bq, dataset: e.target.value })} /></label>
          <label className="text-[11px] text-graphite">Location (optional)
            <input className={input} placeholder="US, EU, asia-southeast2" value={bq.location} onChange={(e) => setBq({ ...bq, location: e.target.value })} /></label>
          <p className="self-end text-[11px] text-mute">Grant BigQuery Data Viewer + Job User. Each query is capped at 10 GiB billed.</p>
        </div>
      )}
      {msg && <p className="mt-2 text-[12px] text-ink">{msg}</p>}
      <button type="button" onClick={build} disabled={kind === "snowflake" ? !sfReady : !bqReady}
        className="mt-3 bg-ink px-3 py-1 text-[12px] font-medium text-paper hover:bg-signal disabled:opacity-40">
        Use this connection
      </button>
    </div>
  );
}
