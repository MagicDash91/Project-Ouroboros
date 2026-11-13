"use client";

// The live thing: the loop as a ring of seven stations. Choosing a station shows what that agent hands on,
// as a real fragment of the product (an example run on sample café data).

import Link from "next/link";
import { useState } from "react";
import { Ring } from "./Ring";

const STATIONS = [
  { key: "brief", name: "Brief", who: "You ask a business question." },
  { key: "plan", name: "Plan", who: "The agents draft a plan; you approve it." },
  { key: "engineer", name: "Engineer", who: "dbt builds and tests the data models." },
  { key: "model", name: "Model", who: "Machine learning finds the drivers." },
  { key: "show", name: "Show", who: "Charts and an interactive dashboard." },
  { key: "report", name: "Report", who: "A PDF and PowerPoint report." },
  { key: "act", name: "Act", who: "The campaign that acts on it." },
] as const;
type Key = (typeof STATIONS)[number]["key"];

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div data-ui className="w-full bg-white text-left text-[13px] leading-snug text-ink shadow-[0_18px_40px_rgba(24,22,19,0.16)]">
      {/* taste-skill-ignore: the product panel's own header rule (data-ui) */}
      <div className="flex items-center justify-between border-b border-rule px-4 py-2.5">
        <span className="text-[13px] font-semibold">{title}</span>
        <span className="h-2 w-2 rounded-full bg-moss" aria-hidden="true" />
      </div>
      <div className="px-4 py-3.5">{children}</div>
    </div>
  );
}

const Tick = () => (
  <span className="mr-2 inline-flex h-4 w-4 items-center justify-center rounded-full bg-moss text-[10px] text-white" aria-hidden="true">
    <svg viewBox="0 0 12 12" className="h-3 w-3" focusable="false">
      <path d="M2.5 6.4 5 8.8 9.6 3.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  </span>
);

function Fragment({ k }: { k: Key }) {
  switch (k) {
    case "brief":
      return (
        <Panel title="New analysis">
          <p className="text-[14px]">Why did repeat orders drop in Q3, and what campaign wins those customers back?</p>
          <div className="mt-3 flex flex-wrap gap-1.5 text-[13px]">
            <span className="bg-paper px-2 py-1">orders_2026.xlsx · 3 sheets</span>
            <span className="bg-paper px-2 py-1">Postgres · cafe_prod</span>
          </div>
        </Panel>
      );
    case "plan":
      return (
        <Panel title="Plan · waiting for you">
          <ol className="space-y-1.5">
            {["Clean and join orders, customers, stores", "Repeat rate by month and store", "Drivers of not coming back", "Win-back campaign for lapsed regulars"].map((s, i) => (
              <li key={s} className="flex gap-2">
                <span className="w-4 text-graphite">{i + 1}.</span>
                {s}
              </li>
            ))}
          </ol>
          <div className="mt-3 inline-block rounded-full bg-ink px-3.5 py-1.5 text-[13px] font-medium text-paper">Approve plan</div>
        </Panel>
      );
    case "engineer":
      return (
        <Panel title="dbt build · 19 of 19 tests passed">
          {[
            ["stg_orders", "6 tests"],
            ["dim_customers", "4 tests"],
            ["fct_orders", "9 tests"],
          ].map(([m, t]) => (
            <div key={m} className="flex items-center justify-between py-1">
              <span className="flex items-center">
                <Tick />
                {m}
              </span>
              <span className="text-graphite">{t}</span>
            </div>
          ))}
          <p className="mt-2 text-[13px] text-graphite">Refreshes every night at 02:00 with Airflow.</p>
        </Panel>
      );
    case "model":
      return (
        <Panel title="What predicts a customer not returning">
          {(
            [
              ["Days since last order", 41],
              ["Delivery fee paid", 22],
              ["No promo in 60 days", 15],
              ["Store: Kemang", 9],
            ] as [string, number][]
          ).map(([n, v]) => (
            <div key={n} className="py-1">
              <div className="flex justify-between">
                <span>{n}</span>
                <span className="tabular-nums text-graphite">{v}%</span>
              </div>
              <div className="mt-1 h-1.5 bg-paper">
                <div className="h-full bg-signal" style={{ width: `${v * 2.2}%` }} />
              </div>
            </div>
          ))}
        </Panel>
      );
    case "show":
      return (
        <Panel title="Repeat rate fell 6.8 points in Q3">
          <div className="flex h-[96px] items-end gap-3 pt-2">
            {(
              [
                ["Jun", 38.2],
                ["Jul", 36.0],
                ["Aug", 34.9],
                ["Sep", 31.4],
              ] as [string, number][]
            ).map(([m, v]) => (
              <div key={m} className="flex flex-1 flex-col items-center gap-1">
                <span className="text-[12px] tabular-nums">{v.toFixed(1)}%</span>
                <div className={m === "Sep" ? "w-full bg-signal" : "w-full bg-ink/80"} style={{ height: `${(v - 25) * 4.4}px` }} />
                <span className="text-[12px] text-graphite">{m}</span>
              </div>
            ))}
          </div>
        </Panel>
      );
    case "report":
      return (
        <Panel title="Q3 retention report · page 4">
          <p className="font-semibold">Lapsed regulars are concentrated in two stores.</p>
          <div className="mt-2 grid grid-cols-2 gap-2 text-[12.5px]">
            <div className="bg-[#E7F0FA] p-2">
              <b className="block text-[#0F6CBD]">Conclusion</b>
              Kemang and Senopati hold 58% of lapsed regulars.
            </div>
            <div className="bg-[#E6F2E6] p-2">
              <b className="block text-[#107C10]">Actionable insight</b>
              Pilot free delivery there for 30 days.
            </div>
          </div>
        </Panel>
      );
    case "act":
      return (
        <Panel title="Campaign · Instagram, retention">
          <p className="font-serif text-[20px] leading-tight">Your usual, on us this week.</p>
          <p className="mt-1.5 text-graphite">For regulars who haven&apos;t ordered in 30 days: free delivery in Kemang and Senopati.</p>
          <div className="mt-3 flex gap-1.5 text-[13px]">
            <span className="bg-paper px-2 py-1">3 ad variants</span>
            <span className="bg-paper px-2 py-1">5 posts</span>
          </div>
        </Panel>
      );
  }
}

export function LoopHero() {
  const [sel, setSel] = useState<Key>("plan");
  const current = STATIONS.find((s) => s.key === sel)!;
  const n = STATIONS.length;

  return (
    <section id="top" className="relative overflow-hidden bg-paper">
      <div className="mx-auto grid max-w-[1440px] gap-10 px-5 pb-16 pt-10 sm:px-8 lg:min-h-[calc(100svh-76px)] lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-center lg:gap-4 lg:pt-4">
        <div className="relative z-10">
          <h1 data-reveal className="max-w-[12ch] font-serif text-[46px] leading-[0.98] tracking-[-0.02em] text-ink sm:text-[64px] lg:text-[clamp(64px,6.4vw,104px)]">
            Data in. Decisions out.
          </h1>
          <p data-reveal className="mt-8 max-w-[520px] text-[18px] leading-[1.55] text-ink lg:text-[20px]">
            Ouroboros is an analytics and marketing desk staffed by AI agents. Connect a database or upload a file, approve the plan, and get
            the data models, dashboard, report and campaign, then the loop runs again on fresh data.
          </p>
          <div data-reveal className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-4">
            <Link
              href="/signup"
              className="rounded-full bg-signal px-8 py-4 text-[17px] font-medium text-white transition-[background-color,transform] hover:bg-ink active:scale-[0.98]"
            >
              Start free
            </Link>
            <Link href="/login" className="text-[17px] text-ink underline decoration-ink/30 underline-offset-[6px] transition-colors hover:decoration-signal">
              Log in
            </Link>
          </div>
          <p data-reveal className="mt-5 text-[15px] text-graphite">
            1,000 credits to start. No card needed.
          </p>
        </div>

        {/* The ring: seven stations; the chosen one's output sits in the middle. */}
        <div className="relative mx-auto w-[min(100%,560px)] lg:mr-0 lg:w-[min(80vh,46vw)] lg:max-w-none">
          <div className="relative aspect-square">
          <Ring className="loop-ring absolute inset-0 h-full w-full text-signal" width={15} />
          <div role="tablist" aria-label="The loop, step by step" className="absolute inset-0">
            {STATIONS.map((s, i) => {
              const a = (-90 + (360 / n) * i) * (Math.PI / 180);
              const r = 42.5; // centre line of the ring, in % of the box
              return (
                <button
                  key={s.key}
                  role="tab"
                  id={`tab-${s.key}`}
                  aria-selected={sel === s.key}
                  aria-controls="loop-panel"
                  onClick={() => setSel(s.key)}
                  style={{ left: `${50 + r * Math.cos(a)}%`, top: `${50 + r * Math.sin(a)}%` }}
                  className={
                    "absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full px-3 py-1.5 text-[13px] font-medium transition-[background-color,color,transform] duration-200 hover:scale-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink sm:px-4 sm:py-2 sm:text-[15px] " +
                    (sel === s.key ? "bg-ink text-paper" : "bg-paper text-ink hover:bg-white")
                  }
                >
                  {s.name}
                </button>
              );
            })}
          </div>
          <div id="loop-panel" role="tabpanel" aria-labelledby={`tab-${sel}`} className="absolute left-1/2 top-1/2 hidden w-[54%] -translate-x-1/2 -translate-y-1/2 sm:block">
            <div key={sel} className="loop-in">
              <p className="mb-2 text-center text-[15px] text-ink">
                <b className="font-semibold">{current.name}.</b> {current.who}
              </p>
              <Fragment k={sel} />
            </div>
          </div>
          </div>
          <p className="mt-3 text-center text-[13px] text-graphite">An example run on sample café data.</p>
        </div>

        {/* Phones: the output sits under the ring. */}
        <div className="-mt-4 sm:hidden" aria-live="polite">
          <div key={sel} className="loop-in">
            <p className="mb-2 text-[15px] text-ink">
              <b className="font-semibold">{current.name}.</b> {current.who}
            </p>
            <Fragment k={sel} />
          </div>
        </div>
      </div>
    </section>
  );
}
