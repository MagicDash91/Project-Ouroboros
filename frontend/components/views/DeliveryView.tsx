"use client";

// Scheduled Delivery: a dashboard (fresh KPIs + change since last time, optional PowerPoint / Excel) or a
// Studio report / deck, sent by email, Slack, Teams or webhook every day, week or month.

import { useCallback, useEffect, useState } from "react";
import { del, errorText, getJSON, postJSON, putJSON } from "@/lib/api";
import { cx } from "@/components/ui";

interface Options {
  dashboards: { id: string; title: string; updated_at?: string }[];
  studio: { ref: string; kind: "doc" | "deck"; title: string; source: string; updated_at?: string }[];
  email_configured: boolean;
  formats: Record<string, string[]>;
}
interface Item { kind: "dashboard" | "studio"; ref: string; studio_kind?: "doc" | "deck"; formats: string[] }
interface Channel { type: "email" | "slack" | "teams" | "webhook"; to?: string[]; url?: string; url_set?: boolean }
interface Cadence { every: "day" | "week" | "month"; at: string; weekday: number; monthday: number }
interface HistoryEntry { at: string; status: "sent" | "failed"; trigger: string; detail: string; seconds: number }
interface Schedule {
  id: string; name: string; item: Item; channel: Channel; cadence: Cadence; enabled: boolean;
  next_run: string | null; last_run: string | null; last_status: string | null; history: HistoryEntry[];
}

const field = "w-full border border-rule bg-white px-2 py-1.5 text-[13px] outline-none focus:border-ink";
const btn = "bg-ink px-4 py-1.5 text-[12px] font-medium text-paper hover:bg-signal disabled:opacity-40";
const ghost = "border border-ink px-3 py-1 text-[12px] hover:bg-ink hover:text-paper disabled:opacity-40";
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const FORMAT_LABEL: Record<string, string> = { summary: "KPI summary in the message", pptx: "PowerPoint", xlsx: "Excel", pdf: "PDF", docx: "Word" };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "–");

function describe(c: Cadence) {
  if (c.every === "day") return `Every day at ${c.at}`;
  if (c.every === "week") return `Every ${DAYS[c.weekday]} at ${c.at}`;
  return `Monthly on day ${c.monthday} at ${c.at}`;
}

export function DeliveryView() {
  const [opts, setOpts] = useState<Options | null>(null);
  const [list, setList] = useState<Schedule[]>([]);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const [o, l] = await Promise.all([getJSON<Options>("/api/delivery/options"), getJSON<Schedule[]>("/api/delivery/schedules")]);
      setOpts(o); setList(l);
    } catch (e) { setErr(errorText(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const itemTitle = (it: Item) =>
    it.kind === "dashboard"
      ? opts?.dashboards.find((d) => d.id === it.ref)?.title || "Dashboard (deleted?)"
      : opts?.studio.find((s) => s.ref === it.ref && s.kind === it.studio_kind)?.title || it.ref;

  return (
    <div className="h-full overflow-y-auto bg-sheet px-6 py-6 lg:px-10">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="font-serif text-[28px] text-ink">Scheduled delivery</h2>
            <p className="mt-1 max-w-2xl text-[13.5px] text-graphite">
              Send a dashboard, report or deck to people every day, week or month. Dashboards are refreshed first, and the
              message shows each KPI with its change since the previous delivery. Free: no AI is involved.
            </p>
          </div>
          {!creating && <button className={btn} onClick={() => setCreating(true)}>+ New delivery</button>}
        </div>

        {opts && !opts.email_configured && (
          <p className="mt-4 border-l-2 border-signal bg-white px-3 py-2 text-[12.5px] text-ink">
            Email isn’t set up on this server yet. Add <span className="font-mono">SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM</span> to
            <span className="font-mono"> .env</span> and restart, or deliver to Slack, Teams or a webhook.
          </p>
        )}
        {err && <p className="mt-4 border-l-2 border-signal bg-white px-3 py-2 text-[13px] text-ink">{err}</p>}

        {creating && opts && <NewDelivery opts={opts} onDone={() => { setCreating(false); load(); }} onCancel={() => setCreating(false)} />}

        <div className="mt-6 space-y-4">
          {!list.length && !creating && <p className="text-[13px] text-graphite">No deliveries yet.</p>}
          {list.map((s) => <ScheduleCard key={s.id} s={s} title={itemTitle(s.item)} onChange={load} />)}
        </div>
      </div>
    </div>
  );
}

function ScheduleCard({ s, title, onChange }: { s: Schedule; title: string; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const where = s.channel.type === "email" ? (s.channel.to || []).join(", ") : `${s.channel.type[0].toUpperCase()}${s.channel.type.slice(1)} · ${s.channel.url}`;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setMsg("");
    try { await fn(); } catch (e) { setMsg(errorText(e)); }
    setBusy(false); onChange();
  };
  return (
    <section className={cx("border bg-white p-5", s.enabled ? "border-rule" : "border-dashed border-rule opacity-70")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-ink">{s.name}</p>
          <p className="text-[12.5px] text-graphite">{title} · {s.item.formats.map((f) => FORMAT_LABEL[f] || f).join(", ")}</p>
          <p className="mt-1 text-[12px] text-graphite">{describe(s.cadence)} → {where}</p>
          <p className="mt-1 text-[11.5px] text-mute">
            {s.enabled ? `Next: ${when(s.next_run)}` : "Paused"}
            {s.last_run && <> · Last: {when(s.last_run)} <span className={s.last_status === "sent" ? "text-ink" : "text-signal"}>({s.last_status})</span></>}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button className={ghost} disabled={busy} onClick={() => act(async () => {
            const r = await postJSON<HistoryEntry>(`/api/delivery/schedules/${s.id}/send`);
            setMsg(r.status === "sent" ? `✓ ${r.detail}` : `Failed: ${r.detail}`);
          })}>{busy ? "Sending…" : "Send now"}</button>
          <button className={ghost} disabled={busy} onClick={() => act(() => putJSON(`/api/delivery/schedules/${s.id}`, { enabled: !s.enabled }))}>{s.enabled ? "Pause" : "Resume"}</button>
          <button className={ghost} disabled={busy} onClick={() => confirm(`Delete “${s.name}”?`) && act(() => del(`/api/delivery/schedules/${s.id}`))}>Delete</button>
        </div>
      </div>
      {msg && <p className={cx("mt-3 text-[12.5px]", msg.startsWith("✓") ? "text-ink" : "text-signal")}>{msg}</p>}
      {s.history.length > 0 && (
        <>
          <button onClick={() => setOpen(!open)} className="mt-3 text-[11.5px] text-graphite underline-offset-2 hover:underline">
            {open ? "Hide" : "Show"} history ({s.history.length})
          </button>
          {open && (
            <ul className="mt-2 space-y-1 border-t border-rule pt-2 text-[12px]">
              {s.history.map((h, i) => (
                <li key={i} className="flex gap-3">
                  <span className="w-40 shrink-0 font-mono text-[11px] text-mute">{when(h.at)}</span>
                  <span className={h.status === "sent" ? "text-ink" : "text-signal"}>{h.status}</span>
                  <span className="text-graphite">{h.detail}{h.trigger === "manual" ? " (sent by hand)" : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function NewDelivery({ opts, onDone, onCancel }: { opts: Options; onDone: () => void; onCancel: () => void }) {
  const choices = [
    ...opts.dashboards.map((d) => ({ key: `dashboard|${d.id}`, label: d.title, group: "Dashboards" })),
    ...opts.studio.map((s) => ({ key: `studio|${s.ref}|${s.kind}`, label: `${s.title} (${s.kind === "doc" ? "report" : "deck"})`, group: s.source })),
  ];
  const [name, setName] = useState("");
  const [choice, setChoice] = useState(choices[0]?.key || "");
  const [formats, setFormats] = useState<string[]>([]);
  const [chan, setChan] = useState<Channel["type"]>(opts.email_configured ? "email" : "slack");
  const [to, setTo] = useState("");
  const [url, setUrl] = useState("");
  const [cad, setCad] = useState<Cadence>({ every: "week", at: "08:00", weekday: 0, monthday: 1 });
  const [sendNow, setSendNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const [kind, ref, studioKind] = choice.split("|") as ["dashboard" | "studio", string, "doc" | "deck" | undefined];
  const avail = kind === "dashboard" ? opts.formats.dashboard : studioKind ? opts.formats[studioKind] : [];
  useEffect(() => { setFormats(avail.slice(0, 1)); }, [choice]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy(true); setErr("");
    try {
      const s = await postJSON<Schedule>("/api/delivery/schedules", {
        name: name || choices.find((c) => c.key === choice)?.label,
        item: { kind, ref, studio_kind: studioKind, formats },
        channel: chan === "email" ? { type: "email", to } : { type: chan, url },
        cadence: cad,
      });
      if (sendNow) {
        const r = await postJSON<HistoryEntry>(`/api/delivery/schedules/${s.id}/send`);
        if (r.status !== "sent") { setErr(`Saved, but the test delivery failed: ${r.detail}`); setBusy(false); return; }
      }
      onDone();
    } catch (e) { setErr(errorText(e)); }
    setBusy(false);
  };

  if (!choices.length) {
    return (
      <section className="mt-5 border border-rule bg-white p-5 text-[13px] text-graphite">
        Nothing to deliver yet: build a dashboard in Boards, or open a report or deck in the editor first.
        <button className={cx(ghost, "ml-3")} onClick={onCancel}>Close</button>
      </section>
    );
  }

  return (
    <section className="mt-5 border border-ink bg-white p-5">
      <h3 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-ink">New delivery</h3>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="text-[12px] text-graphite">What to send
          <select className={cx(field, "mt-1")} value={choice} onChange={(e) => setChoice(e.target.value)}>
            {Array.from(new Set(choices.map((c) => c.group))).map((g) => (
              <optgroup key={g} label={g}>{choices.filter((c) => c.group === g).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</optgroup>
            ))}
          </select>
        </label>
        <label className="text-[12px] text-graphite">Name (optional)
          <input className={cx(field, "mt-1")} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Monday sales update" />
        </label>
      </div>

      <fieldset className="mt-4">
        <legend className="text-[12px] text-graphite">Include</legend>
        <div className="mt-1 flex flex-wrap gap-4">
          {avail.map((f) => (
            <label key={f} className="flex items-center gap-1.5 text-[12.5px] text-ink">
              <input type="checkbox" checked={formats.includes(f)} onChange={(e) => setFormats((x) => e.target.checked ? [...x, f] : x.filter((y) => y !== f))} />
              {FORMAT_LABEL[f] || f}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-4 grid gap-4 sm:grid-cols-[200px_1fr]">
        <label className="text-[12px] text-graphite">Send to
          <select className={cx(field, "mt-1")} value={chan} onChange={(e) => setChan(e.target.value as Channel["type"])}>
            <option value="email" disabled={!opts.email_configured}>Email{opts.email_configured ? "" : " (not set up)"}</option>
            <option value="slack">Slack</option>
            <option value="teams">Microsoft Teams</option>
            <option value="webhook">Webhook (JSON)</option>
          </select>
        </label>
        {chan === "email" ? (
          <label className="text-[12px] text-graphite">Recipients (comma separated, up to 20)
            <input className={cx(field, "mt-1")} value={to} onChange={(e) => setTo(e.target.value)} placeholder="ana@company.co.id, budi@company.co.id" />
          </label>
        ) : (
          <label className="text-[12px] text-graphite">{chan === "webhook" ? "Webhook URL" : "Incoming webhook URL"} (https, kept secret)
            <input className={cx(field, "mt-1 font-mono")} value={url} onChange={(e) => setUrl(e.target.value)}
              placeholder={chan === "slack" ? "https://hooks.slack.com/services/…" : chan === "teams" ? "https://….webhook.office.com/…" : "https://example.com/hook"} />
          </label>
        )}
      </div>
      {chan !== "email" && chan !== "webhook" && formats.some((f) => f !== "summary") && (
        <p className="mt-2 text-[11.5px] text-mute">Chat webhooks can’t carry files: the message links to Ouroboros instead. Choose email to get attachments.</p>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <label className="text-[12px] text-graphite">How often
          <select className={cx(field, "mt-1")} value={cad.every} onChange={(e) => setCad({ ...cad, every: e.target.value as Cadence["every"] })}>
            <option value="day">Every day</option><option value="week">Every week</option><option value="month">Every month</option>
          </select>
        </label>
        {cad.every === "week" && (
          <label className="text-[12px] text-graphite">On
            <select className={cx(field, "mt-1")} value={cad.weekday} onChange={(e) => setCad({ ...cad, weekday: Number(e.target.value) })}>
              {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
          </label>
        )}
        {cad.every === "month" && (
          <label className="text-[12px] text-graphite">On day
            <select className={cx(field, "mt-1")} value={cad.monthday} onChange={(e) => setCad({ ...cad, monthday: Number(e.target.value) })}>
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d}>{d}</option>)}
            </select>
          </label>
        )}
        <label className="text-[12px] text-graphite">At (server time)
          <input type="time" className={cx(field, "mt-1")} value={cad.at} onChange={(e) => setCad({ ...cad, at: e.target.value })} />
        </label>
      </div>

      <label className="mt-4 flex items-center gap-2 text-[12.5px] text-ink">
        <input type="checkbox" checked={sendNow} onChange={(e) => setSendNow(e.target.checked)} /> Send one now to test it
      </label>
      {err && <p className="mt-3 border-l-2 border-signal px-3 py-1 text-[12.5px] text-ink">{err}</p>}
      <div className="mt-4 flex gap-3">
        <button className={btn} disabled={busy || !choice || !formats.length || (chan === "email" ? !to.trim() : !url.trim())} onClick={save}>
          {busy ? "Saving…" : "Save delivery"}
        </button>
        <button className={ghost} onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}
