"use client";

import { useState } from "react";
import { useToast } from "@/components/Overlays";
import { Button, cx } from "@/components/ui";
import { errorText, postJSON, putJSON } from "@/lib/api";
import { type Billing, type LedgerEntry, type Plan, fmtCredits, fmtIdr, fmtUsd } from "@/lib/billing";

/** Plans with a monthly credit allowance, credit top-ups, the action rate card and usage. All prices come from pricing.json. */

type Currency = "usd" | "idr";
type Interval = "month" | "year";

const KIND_LABEL: Record<LedgerEntry["kind"], string> = {
  grant: "Credits granted",
  charge: "Used",
  refund: "Refund",
  refund_grant: "Refund",
  topup: "Top-up",
  subscribe: "Plan change",
  expire: "Expired",
  migrate: "Migration",
};

const BUCKET_LABEL: Record<string, string> = {
  rollover: "Rollover",
  plan: "Plan",
  free_monthly: "Free monthly",
  free_signup: "Signup",
  topup: "Top-up",
};

const fmtDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";

function money(n: number | null | undefined, cur: Currency) {
  if (n === null || n === undefined) return "Custom";
  return cur === "usd" ? fmtUsd(n) : fmtIdr(n);
}

function planPrice(p: Plan, cur: Currency, period: Interval) {
  const month = cur === "usd" ? p.usd_month : p.idr_month;
  const year = cur === "usd" ? p.usd_year : p.idr_year;
  if (p.contact) return { main: year ? `From ${money(year, cur)}` : "Custom", sub: "per year, by contract" };
  if (!month) return { main: money(0, cur), sub: "forever" };
  if (period === "year" && year) {
    const perMonth = cur === "usd" ? Math.round((year / 12) * 100) / 100 : Math.round(year / 12 / 1000) * 1000;
    return { main: money(year, cur), sub: `per year · ${money(perMonth, cur)} / month` };
  }
  return { main: money(month, cur), sub: "per month" };
}

function features(p: Plan): string[] {
  return [
    `${p.seats} seat${p.seats === "1" ? "" : "s"}`,
    `Scheduled workflows: ${p.schedules}`,
    `${p.concurrent} concurrent task${p.concurrent === "1" ? "" : "s"}`,
    `Uploads up to ${p.upload_mb} per file`,
    `${p.db_connections} database connection${p.db_connections === "1" ? "" : "s"}`,
    "dbt modelling in every Analytics run",
    ...(p.airflow ? ["Airflow schedules for dbt"] : []),
    ...(p.shared_workspace ? ["Shared workspace and roles"] : []),
    ...(p.enterprise ? ["SSO, audit export, private deployment, SLA"] : []),
  ];
}

function SpendingControls({
  billing,
  busy,
  setBusy,
  onChange,
}: {
  billing: Billing;
  busy: string | null;
  setBusy: (b: string | null) => void;
  onChange: (b: Billing) => void;
}) {
  const toast = useToast();
  const { spend_cap_usd: cap, auto_topup: auto } = billing.settings;
  const [draft, setDraft] = useState(cap === null ? "" : String(cap));
  const smallest = billing.pricing.packs.reduce((a, b) => (b.usd < a.usd ? b : a));

  async function save(body: { spend_cap_usd?: number | null; auto_topup?: boolean }) {
    setBusy("settings");
    try {
      const next = await putJSON<Billing>("/api/billing/settings", body);
      onChange(next);
      setDraft(next.settings.spend_cap_usd === null ? "" : String(next.settings.spend_cap_usd));
      toast("Spending settings saved.", "ok");
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setBusy(null);
    }
  }

  const parsed = draft.trim() === "" ? null : Number(draft);
  const invalid = parsed !== null && (!Number.isFinite(parsed) || parsed < 0);
  const dirty = !invalid && parsed !== cap;

  return (
    <section>
      <h2 className="label mb-3">Spending controls</h2>
      <div className="space-y-4 border border-rule bg-white px-4 py-4">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            className="mt-0.5 accent-signal"
            checked={auto}
            disabled={busy !== null}
            onChange={(e) => save({ auto_topup: e.target.checked })}
          />
          <span className="text-[12.5px] leading-snug text-graphite">
            <b className="text-ink">Auto top-up.</b> When a task would leave you under {fmtCredits(billing.pricing.rules.auto_topup_below)} credits, buy{" "}
            {fmtCredits(smallest.credits)} credits ({fmtUsd(smallest.usd)}) instead of refusing it.
          </span>
        </label>
        <div>
          <div className="text-[12.5px] text-ink">
            <b>Monthly top-up cap</b> <span className="text-mute">(USD, empty = no cap)</span>
          </div>
          <div className="mt-1.5 flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              inputMode="decimal"
              placeholder="No cap"
              aria-label="Monthly top-up cap in USD"
              className={cx("w-full border px-2 py-1 font-mono text-[12.5px]", invalid ? "border-signal" : "border-rule")}
            />
            <Button tone="line" size="sm" disabled={busy !== null || !dirty} onClick={() => save({ spend_cap_usd: parsed })}>
              {busy === "settings" ? "Saving…" : "Save"}
            </Button>
          </div>
          <p className="mt-1.5 text-[11px] text-mute">
            {cap === null ? "No cap set." : `Top-ups stop at ${fmtUsd(cap)} per period.`} If credits run out, a paid workflow step stops with an error and the steps after it are skipped; nothing runs on credit.
          </p>
        </div>
      </div>
    </section>
  );
}

export function PricingView({
  billing,
  error,
  onChange,
  onRetry,
}: {
  billing: Billing | null;
  error: string;
  onChange: (b: Billing) => void;
  onRetry: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [cur, setCur] = useState<Currency>("usd");
  const [period, setPeriod] = useState<Interval>("month");

  if (!billing) {
    if (!error) return <p className="px-10 py-10 text-[13px] italic text-mute">Loading prices…</p>;
    const missing = /not found|404/i.test(error);
    return (
      <div className="mx-auto max-w-[640px] px-6 py-12">
        <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-signal">Pricing unavailable</div>
        <p className="mt-3 text-[14px] text-ink">
          {missing
            ? "The backend doesn't have the billing routes yet. It's still running older code. Restart it (Ctrl+C, then python main.py) and try again."
            : error}
        </p>
        <Button tone="line" size="sm" className="mt-5" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  if (!billing.pricing) {
    return (
      <div className="mx-auto max-w-[640px] px-6 py-12">
        <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-signal">Restart needed</div>
        <p className="mt-3 text-[14px] text-ink">
          The backend is still running the old token pricing. Restart it (Ctrl+C, then python main.py) to switch to plans and credits.
        </p>
        <Button tone="line" size="sm" className="mt-5" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  const { pricing, plan: current } = billing;
  const unit = (credits: number) =>
    cur === "usd" ? fmtUsd(Math.round(credits * pricing.credit_value_usd * 100) / 100) : fmtIdr(credits * pricing.credit_value_idr);

  async function subscribe(p: Plan) {
    setBusy(p.id);
    try {
      const next = await postJSON<Billing>("/api/billing/subscribe", { plan_id: p.id, interval: period });
      onChange(next);
      toast(`You're on ${p.name}.${p.credits_month ? ` ${fmtCredits(p.credits_month)} credits added.` : ""}`, "ok");
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setBusy(null);
    }
  }

  async function topup(id: string) {
    setBusy(id);
    try {
      const next = await postJSON<Billing>("/api/billing/topup", { pack_id: id });
      onChange(next);
      toast(`Credits added. Balance: ${fmtCredits(next.balance)}`, "ok");
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setBusy(null);
    }
  }

  const buckets = pricing.rules.spend_order.filter((k) => billing.buckets[k]?.credits);
  const currentPlan = pricing.plans.find((p) => p.id === current.id);

  return (
    <div className="h-full lg:overflow-y-auto">
      <div className="mx-auto max-w-[1180px] px-6 py-10 lg:px-10">
        {/* Header + wallet */}
        <div className="flex flex-col justify-between gap-6 border-b border-ink pb-7 lg:flex-row lg:items-end">
          <div className="max-w-[600px]">
            <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-signal">Pricing</div>
            <h1 className="mt-2 font-serif text-[36px] leading-[1.1] text-ink">Start free. Pay for the analysis, not the questions.</h1>
            <p className="mt-2 text-[13.5px] leading-relaxed text-graphite">
              Every plan includes credits for full analytics runs, data chat, the autonomous agent and scheduled workflows.
              Failed or stopped work is always refunded.
            </p>
          </div>
          <div className="w-full shrink-0 border border-ink bg-white px-5 py-4 lg:w-[360px]">
            <div className="flex items-baseline justify-between">
              <div className="label">Your credits</div>
              <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-signal">
                {current.name}
                {current.id !== "free" ? ` · ${current.interval === "year" ? "annual" : "monthly"}` : ""}
              </span>
            </div>
            <div className="mt-1 font-serif text-[40px] leading-none tabular-nums text-ink">{fmtCredits(billing.balance)}</div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {buckets.map((k) => (
                <span
                  key={k}
                  className="border border-rule bg-sheet/60 px-2 py-0.5 font-mono text-[10.5px] text-graphite"
                  title={billing.buckets[k].expires_at ? `Expires ${fmtDate(billing.buckets[k].expires_at)}` : "Never expires"}
                >
                  {BUCKET_LABEL[k] ?? k} {fmtCredits(billing.buckets[k].credits)}
                </span>
              ))}
            </div>
            <p className="mt-3 text-[11.5px] text-mute">
              {fmtCredits(billing.used_this_period)} used this period ·{" "}
              {currentPlan?.credits_month ? `${fmtCredits(currentPlan.credits_month)} new credits` : "renews"} on {fmtDate(current.period_end)}
            </p>
          </div>
        </div>

        {billing.demo_checkout && (
          <p className="mt-5 border-l-2 border-signal bg-signal/5 px-4 py-2 text-[12.5px] text-ink">
            Demo checkout: choosing a plan or buying credits takes effect immediately and no payment is taken. Real checkout
            (Stripe for USD, Xendit or Midtrans for IDR) comes with user accounts.
          </p>
        )}

        {/* Toggles */}
        <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
          <h2 className="label">Plans</h2>
          <div className="flex flex-wrap gap-3">
            <div className="flex border border-ink text-[12px]" role="group" aria-label="Billing period">
              {(["month", "year"] as Interval[]).map((i) => (
                <button key={i} onClick={() => setPeriod(i)} className={cx("px-3 py-1.5", period === i ? "bg-ink text-paper" : "text-graphite hover:text-ink")}>
                  {i === "month" ? "Monthly" : "Annual · 2 months free"}
                </button>
              ))}
            </div>
            <div className="flex border border-ink text-[12px]" role="group" aria-label="Currency">
              {(["usd", "idr"] as Currency[]).map((c) => (
                <button key={c} onClick={() => setCur(c)} className={cx("px-3 py-1.5 font-mono", cur === c ? "bg-ink text-paper" : "text-graphite hover:text-ink")}>
                  {c.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Plan cards */}
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {pricing.plans.map((p) => {
            const price = planPrice(p, cur, period);
            const isCurrent = p.id === current.id;
            const sameTerms = isCurrent && (p.id === "free" || current.interval === period);
            return (
              <div
                key={p.id}
                className={cx(
                  "relative flex flex-col border bg-white p-5",
                  p.popular ? "border-ink shadow-[4px_4px_0_0_rgba(0,0,0,0.85)]" : "border-rule",
                  isCurrent && "ring-2 ring-signal/40",
                )}
              >
                {p.popular && (
                  <span className="absolute -top-2.5 left-5 bg-signal px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-white">
                    Most popular
                  </span>
                )}
                <div className="font-serif text-[22px] text-ink">{p.name}</div>
                <p className="mt-1 min-h-[34px] text-[12px] leading-snug text-graphite">{p.tagline}</p>
                <div className="mt-4 text-[24px] font-semibold tabular-nums leading-none text-ink">{price.main}</div>
                <div className="mt-1 font-mono text-[10.5px] text-mute">{price.sub}</div>
                <div className="mt-4 border-t border-rule pt-3">
                  <div className="text-[13px] font-semibold tabular-nums text-ink">
                    {p.credits_month === null
                      ? "Contracted credits"
                      : p.signup_credits
                        ? `${fmtCredits(p.signup_credits)} at signup + ${fmtCredits(p.credits_month)} / month`
                        : `${fmtCredits(p.credits_month)} credits / month${p.shared_workspace ? ", shared" : ""}`}
                  </div>
                  <div className="text-[11.5px] text-mute">≈ {p.equals}</div>
                </div>
                <ul className="mt-3 flex-1 space-y-1 text-[11.5px] text-graphite">
                  {features(p).map((f) => (
                    <li key={f} className="flex gap-1.5">
                      <span className="text-moss">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>
                {p.contact ? (
                  <div className="mt-4 border border-rule px-3 py-2 text-center text-[12px] text-graphite">Contact sales</div>
                ) : (
                  <Button
                    tone={sameTerms ? "quiet" : p.popular ? "ink" : "line"}
                    size="sm"
                    className="mt-4 w-full"
                    disabled={busy !== null || sameTerms}
                    onClick={() => subscribe(p)}
                  >
                    {sameTerms
                      ? "Current plan"
                      : busy === p.id
                        ? "Switching…"
                        : isCurrent
                          ? `Switch to ${period === "year" ? "annual" : "monthly"}`
                          : `Choose ${p.name}`}
                  </Button>
                )}
              </div>
            );
          })}
        </div>

        {/* Rate card + top-ups */}
        <div className="mt-12 grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
          <section>
            <h2 className="label mb-3">What things cost</h2>
            <div className="overflow-x-auto border border-rule bg-white">
              <table className="w-full border-collapse text-[12.5px]">
                <thead>
                  <tr>
                    {["Action", "Credits", `Top-up value (${cur.toUpperCase()})`].map((h, i) => (
                      <th
                        key={h}
                        className={cx("border-b-[1.5px] border-ink px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-mute", i > 0 && "text-right")}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(pricing.actions).map(([k, a]) => (
                    <tr key={k} className="border-b border-rule last:border-0">
                      <td className="px-3 py-2">
                        <div className="text-ink">{a.label}</div>
                        <div className="text-[11px] text-mute">{a.detail}</div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-mono tabular-nums text-ink">{fmtCredits(a.credits)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-mono tabular-nums text-graphite">{unit(a.credits)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[11.5px] text-mute">
              Free: {pricing.free_actions.join(" · ")}. 1 credit = {cur === "usd" ? fmtUsd(pricing.credit_value_usd) : fmtIdr(pricing.credit_value_idr)} at
              top-up price; plan credits cost less.
            </p>
          </section>

          <aside className="space-y-8">
            <section>
              <h2 className="label mb-3">Top up credits</h2>
              <div className="space-y-2">
                {pricing.packs.map((p) => (
                  <div key={p.id} className={cx("flex items-center gap-3 border bg-white px-4 py-3", p.popular ? "border-ink" : "border-rule")}>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold tabular-nums text-ink">
                        {fmtCredits(p.credits)} credits <span className="font-normal text-mute">· {p.name}</span>
                      </div>
                      <div className="font-mono text-[10.5px] text-mute">
                        {cur === "usd" ? `${fmtUsd(Math.round((p.usd / p.credits) * 10000) / 10000)} per credit` : `${fmtIdr(Math.round(p.idr / p.credits))} per credit`} · never expire
                      </div>
                    </div>
                    <Button tone={p.popular ? "ink" : "line"} size="sm" disabled={busy !== null} onClick={() => topup(p.id)}>
                      {busy === p.id ? "Adding…" : money(cur === "usd" ? p.usd : p.idr, cur)}
                    </Button>
                  </div>
                ))}
              </div>
            </section>

            <SpendingControls billing={billing} busy={busy} setBusy={setBusy} onChange={onChange} />

            <section>
              <h2 className="label mb-2">How credits work</h2>
              <ul className="space-y-1.5 text-[12px] leading-snug text-graphite">
                <li>
                  <b className="text-ink">Spend order:</b> {pricing.rules.spend_order.map((k) => BUCKET_LABEL[k] ?? k).join(" → ")}, soonest-expiring first.
                </li>
                <li>
                  <b className="text-ink">Rollover:</b> up to {pricing.rules.rollover_pct_of_allowance}% of your plan&apos;s monthly credits carry into the next month.
                </li>
                <li>
                  <b className="text-ink">Top-ups</b> never expire.
                </li>
                <li>
                  <b className="text-ink">Refunds:</b> credits come back automatically if work fails, is aborted at review, is stopped, or is blocked by security screening.
                </li>
                <li>
                  <b className="text-ink">Low balance:</b> the request is refused and nothing is charged, unless auto top-up is on.
                </li>
                <li>
                  <b className="text-ink">Spend cap:</b> top-ups in one period (manual and automatic) stop at your cap, by default 2× the plan price or $20.
                </li>
                <li>
                  <b className="text-ink">Annual billing:</b> pay for 10 months, get 12.
                </li>
              </ul>
            </section>
          </aside>
        </div>

        {/* Activity */}
        <h2 className="label mb-3 mt-12">Recent activity</h2>
        {billing.ledger.length === 0 ? (
          <p className="text-[12px] italic text-mute">Nothing yet.</p>
        ) : (
          <div className="overflow-x-auto border border-rule bg-white">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr>
                  {["When", "Type", "Detail", "Credits"].map((h, i) => (
                    <th
                      key={h}
                      className={cx("border-b-[1.5px] border-ink px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-mute", i === 3 && "text-right")}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {billing.ledger.slice(0, 30).map((e) => (
                  <tr key={e.id} className="border-b border-rule last:border-0">
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-mute">{e.ts.replace("T", " ").slice(0, 16)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-graphite">{KIND_LABEL[e.kind] ?? e.kind}</td>
                    <td className="px-3 py-2 text-graphite">{e.note}</td>
                    <td className={cx("whitespace-nowrap px-3 py-2 text-right font-mono tabular-nums", e.credits > 0 ? "text-moss" : e.credits < 0 ? "text-ink" : "text-mute")}>
                      {e.credits > 0 ? "+" : e.credits < 0 ? "−" : ""}
                      {e.credits ? fmtCredits(Math.abs(e.credits)) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
