"use client";

import { StartHere } from "@/components/StartHere";
import { Fragment } from "react";
import { ArtSlot, type Tint } from "@/components/ArtSlot";
import { Button, cx } from "@/components/ui";

/** Introductory page: what the desk does, how it compares, and where to start. */

type Go = (app: "analytics" | "datachat" | "agent" | "workflow" | "pricing" | "guide") => void;

const PIPELINE = [
  { step: "Plan", note: "LangGraph drafts the analysis; you approve it" },
  { step: "Engineer", note: "dbt models and tests, scheduled with Airflow" },
  { step: "Model", note: "Forecasts, segments, classifiers, SHAP drivers" },
  { step: "Show", note: "AI-written charts and a Power BI-style dashboard" },
  { step: "Report", note: "Insight report as PDF and PowerPoint" },
  { step: "Act", note: "Marketing strategy, ad copy and social posts" },
];

const AUDIENCES = [
  {
    who: "Analysts and small data teams",
    why: "Hand off the repetitive pipeline (modelling, testing, charting, reporting) and spend your time on the questions that need a person.",
  },
  {
    who: "Marketing and growth teams",
    why: "Get campaigns grounded in your own customer data, with the drivers and segments behind every recommendation, not generic best practice.",
  },
  {
    who: "Founders and managers without a data team",
    why: "Ask questions in plain language and get answers with the SQL or Python shown, plus a dashboard you can filter yourself.",
  },
];

const TRUST = [
  { title: "You approve the plan", body: "Analyses and Agent tasks start with a plan you can edit. Nothing runs until you say so." },
  {
    title: "Your source data stays untouched",
    body: "Questions run as read-only queries. dbt writes only to its own schemas, never to your tables.",
  },
  {
    title: "Personal data masked",
    body: "In Data chat and AI workflow steps, names, emails, phone numbers and similar columns are pseudonymised before the AI sees them.",
  },
  {
    title: "Injection screening",
    body: "Instructions hidden in your data or in web pages the Agent reads are flagged and treated as data, never obeyed.",
  },
  {
    title: "Sandboxed code",
    body: "In Data chat and the Agent, AI-written Python runs in a separate, locked-down process with no access to your keys.",
  },
  {
    title: "Every answer shows its work",
    body: "See the SQL and Python behind each answer, and pay only for work that finishes: failures are refunded.",
  },
];

const SOURCES = [
  "PostgreSQL",
  "Supabase",
  "MySQL",
  "SQL Server",
  "Oracle",
  "Amazon Redshift",
  "Google BigQuery",
  "DuckDB",
  "CSV",
  "Excel",
  "Parquet",
  "JSON",
  "Google Sheets",
  "Google Drive",
  "Slack",
  "Notion",
  "Airtable",
];

const TOOLS = ["This desk", "Julius AI", "Manus AI", "ChatGPT data analysis", "Power BI Copilot", "Databricks Genie"];

type Mark = "y" | "p" | "n";
const ROWS: { group: string; items: [string, Mark[]][] }[] = [
  {
    group: "Ask your data",
    items: [
      ["Chat with files or a database", ["y", "y", "p", "p", "y", "y"]],
      ["Shows the code behind each answer", ["y", "y", "p", "y", "n", "y"]],
      ["Connects to many database types", ["y", "p", "n", "n", "y", "p"]],
    ],
  },
  {
    group: "Analysis pipeline",
    items: [
      ["Full multi-step analysis from one brief", ["y", "n", "y", "n", "n", "n"]],
      ["You approve the plan before work starts", ["y", "n", "p", "n", "n", "n"]],
      ["Data engineering (dbt models and tests)", ["y", "n", "n", "n", "n", "p"]],
      ["Scheduled pipelines (Airflow)", ["y", "n", "n", "n", "p", "y"]],
    ],
  },
  {
    group: "Machine learning",
    items: [
      ["Forecasting, segmentation, classifiers", ["y", "y", "p", "y", "p", "y"]],
      ["Drivers (SHAP) and what-if scenarios", ["y", "p", "n", "p", "n", "p"]],
      ["Score new data with trained models", ["y", "n", "n", "n", "n", "y"]],
      ["Drift monitoring", ["y", "n", "n", "n", "n", "y"]],
    ],
  },
  {
    group: "Outputs",
    items: [
      ["Automatic interactive dashboard", ["y", "n", "p", "n", "y", "y"]],
      ["PDF and PowerPoint reports", ["y", "p", "y", "p", "n", "n"]],
      ["Marketing strategy and content from the insights", ["y", "n", "y", "p", "n", "n"]],
      ["Knowledge graph", ["y", "n", "n", "n", "n", "n"]],
      ["Q&A over your documents (RAG)", ["y", "n", "p", "y", "n", "n"]],
    ],
  },
  {
    group: "Trust & security",
    items: [
      ["Personal data masked before the AI sees it", ["y", "n", "n", "n", "p", "p"]],
      ["Prompt-injection screening, read-only by design", ["y", "p", "p", "p", "y", "y"]],
    ],
  },
  {
    group: "Autonomy",
    items: [
      ["Browses the web and acts on its own", ["y", "n", "y", "y", "n", "n"]],
      ["Parallel researcher agents (wide research)", ["y", "n", "y", "n", "n", "n"]],
      ["Agent can query your database safely", ["y", "n", "n", "n", "n", "p"]],
    ],
  },
];

function MarkCell({ m, ours }: { m: Mark; ours: boolean }) {
  const label = m === "y" ? "Yes" : m === "p" ? "Partly" : "No";
  return (
    <td className={cx("border-b border-rule px-3 py-2.5 text-center", ours && "bg-signal/[0.06]")}>
      <span
        aria-label={label}
        title={label}
        className={cx(
          "inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold",
          m === "y" && (ours ? "bg-signal text-white" : "bg-ink text-paper"),
          m === "p" && "border border-graphite/60 text-graphite",
          m === "n" && "text-mute/70",
        )}
      >
        {m === "y" ? "✓" : m === "p" ? "½" : "—"}
      </span>
    </td>
  );
}

export function HomeView({ onGo }: { onGo: Go }) {
  return (
    <div className="h-full lg:overflow-y-auto">
      <section className="border-b border-ink">
        <div className="mx-auto grid max-w-[1120px] items-center gap-10 px-6 pb-14 pt-16 lg:grid-cols-[minmax(0,1fr)_400px] lg:px-10">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-signal">Ouroboros</div>
            <h1 className="mt-4 max-w-[820px] font-serif text-[44px] leading-[1.05] text-ink md:text-[58px]">
              From raw data to a decision, and the campaign that acts on it.
            </h1>
            <p className="mt-5 max-w-[640px] text-[16px] leading-relaxed text-graphite">
              An analytics and marketing desk staffed by AI agents. Point it at a database or a file and it engineers the data, models it,
              builds the dashboard, writes the report and drafts the campaign, with you approving the plan.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button tone="ink" size="lg" onClick={() => onGo("analytics")}>
                Start an analysis
              </Button>
              <Button tone="line" size="lg" onClick={() => onGo("datachat")}>
                Ask your data a question
              </Button>
            </div>
          </div>
          <ArtSlot
            name="hero"
            tint="sage"
            alt="Painting of a woman whose face is replaced by wild flowers, wrapped in green thread"
            className="aspect-[3/4] w-full max-w-[400px] justify-self-center lg:justify-self-end"
          />
        </div>
      </section>

      <StartHere onGo={onGo} />

      <section className="border-b border-rule">
        <div className="mx-auto grid max-w-[1120px] gap-10 px-6 py-14 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:px-10">
          <div>
            <h2 className="label">What Ouroboros is</h2>
            <p className="mt-3 font-serif text-[30px] leading-[1.15] text-ink md:text-[34px]">
              A whole data team&apos;s work, done by AI agents and supervised by you.
            </p>
          </div>
          <div className="space-y-4 text-[14.5px] leading-relaxed text-graphite">
            <p>
              Getting from data to action usually takes a relay of specialists: someone to clean and model the data, an analyst to explore
              it, a data scientist to forecast and explain it, a BI developer to build the dashboard, and a marketer to turn the findings
              into a campaign. Every handoff costs days, and context gets lost along the way.
            </p>
            <p>
              Ouroboros puts an AI agent in each of those seats and has them work from <b className="font-semibold text-ink">one brief</b>.
              Describe the business question and connect your data. The agents draft a plan; you approve or edit it; then they do the work:
              tested dbt data models, machine-learning models, charts, an interactive dashboard, a PDF and PowerPoint report, and a
              marketing campaign built on what your data actually shows.
            </p>
            <p>
              The name is the idea. The ouroboros is the serpent that eats its own tail, a loop that never ends. Airflow refreshes your data
              models on schedule, monitors watch for drift, and workflows rerun the analysis every hour, day or week, so each decision
              starts from fresh data instead of from scratch.
            </p>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-[1120px] px-6 py-14 lg:px-10">
        <h2 className="label mb-4">One brief, the whole chain</h2>
        <ol className="grid gap-px border border-rule bg-rule sm:grid-cols-2 lg:grid-cols-6">
          {PIPELINE.map((p, i) => (
            <li key={p.step} className="bg-paper p-4">
              <span className="font-mono text-[11px] text-mute">{String(i + 1).padStart(2, "0")}</span>
              <div className="mt-1 font-serif text-[20px] text-ink">{p.step}</div>
              <p className="mt-1 text-[12px] leading-snug text-graphite">{p.note}</p>
            </li>
          ))}
        </ol>

        <h2 className="label mb-4 mt-14">Four ways to work</h2>
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
          {[
            {
              key: "analytics" as const,
              title: "Analytics",
              cost: "900 credits per run",
              body: "The full desk for a business question: plan, data models, ML, dashboard, PDF and PowerPoint report, and a marketing campaign. Takes minutes; you review the plan first.",
              cta: "Open Analytics",
              tint: "sand" as Tint,
            },
            {
              key: "datachat" as const,
              title: "Data chat",
              cost: "5 credits per question",
              body: "Quick answers from a file or a database, with the SQL or Python behind every answer, tables and charts. Read-only, with personal data masked.",
              cta: "Open Data chat",
              tint: "sky" as Tint,
            },
            {
              key: "agent" as const,
              title: "Agent",
              cost: "from 100 credits per task",
              body: "Give it a goal and it works on its own: searches and browses the web, reads sources, analyses your data and writes the report. Repeated research runs in parallel. You approve the plan first.",
              cta: "Open Agent",
              tint: "rose" as Tint,
            },
            {
              key: "workflow" as const,
              title: "Workflow",
              cost: "free steps · AI steps from 2 credits",
              body: "Chain data, transforms, ML, AI and outputs on a canvas, or describe it and AI builds the workflow. Run it once or schedule it every hour, day or week.",
              cta: "Open Workflow",
              tint: "sage" as Tint,
            },
          ].map((a) => (
            <div key={a.key} className="flex flex-col border border-ink bg-white">
              <ArtSlot name={a.key} tint={a.tint} alt="" className="aspect-[4/3] w-full border-b border-ink" />
              <div className="flex flex-1 flex-col p-6">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="font-serif text-[26px] text-ink">{a.title}</span>
                  <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-signal">{a.cost}</span>
                </div>
                <p className="mt-2 flex-1 text-[13.5px] leading-relaxed text-graphite">{a.body}</p>
                <Button tone="line" size="sm" className="mt-5 self-start" onClick={() => onGo(a.key)}>
                  {a.cta} →
                </Button>
              </div>
            </div>
          ))}
        </div>

        <h2 className="label mb-4 mt-16">Who it&apos;s for</h2>
        <div className="grid gap-px border border-rule bg-rule md:grid-cols-3">
          {AUDIENCES.map((a) => (
            <div key={a.who} className="bg-paper p-6">
              <div className="font-serif text-[21px] leading-tight text-ink">{a.who}</div>
              <p className="mt-2 text-[13.5px] leading-relaxed text-graphite">{a.why}</p>
            </div>
          ))}
        </div>

        <div className="mt-16 grid gap-10 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
          <section>
            <h2 className="label">Built to be trusted</h2>
            <p className="mt-2 font-serif text-[24px] leading-tight text-ink">AI does the work. You keep control of the data.</p>
            <ul className="mt-5 grid gap-x-8 gap-y-4 sm:grid-cols-2">
              {TRUST.map((t) => (
                <li key={t.title} className="border-t border-ink pt-3">
                  <div className="text-[13.5px] font-semibold text-ink">{t.title}</div>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-graphite">{t.body}</p>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2 className="label">Works with your data</h2>
            <p className="mt-2 font-serif text-[24px] leading-tight text-ink">Connect a database or an app, or just upload a file.</p>
            <div className="mt-5 flex flex-wrap gap-1.5">
              {SOURCES.map((s) => (
                <span key={s} className="border border-rule bg-white px-2.5 py-1 text-[12px] text-ink">
                  {s}
                </span>
              ))}
            </div>
            <p className="mt-4 text-[12.5px] leading-relaxed text-graphite">
              Paste a connection string in whatever form your provider gives you (a URL, JDBC, or an Azure/ODBC string) and Ouroboros
              converts it, adds SSL for managed databases, and tests the connection before anything runs. Or bring in a Google Sheet, a
              Drive file, a Slack channel&apos;s history, a Notion database or an Airtable table, and it arrives as a table like any upload.
            </p>
          </section>
        </div>

        <div className="mb-4 mt-16 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="label">How it compares</h2>
            <p className="mt-1 font-serif text-[26px] leading-tight text-ink">
              Most tools cover one or two steps. This desk covers the chain.
            </p>
          </div>
          <div className="flex items-center gap-4 font-mono text-[10.5px] uppercase tracking-[0.08em] text-mute">
            <span className="flex items-center gap-1.5">
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-ink text-[9px] text-paper">✓</span>
              Yes
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-graphite/60 text-[9px]">½</span>
              Partly
            </span>
            <span className="flex items-center gap-1.5">— No</span>
          </div>
        </div>

        <div className="overflow-x-auto border border-ink bg-white">
          <table className="w-full min-w-[820px] border-collapse text-[13px]">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 border-b-[1.5px] border-ink bg-white px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-mute">
                  Capability
                </th>
                {TOOLS.map((t, i) => (
                  <th
                    key={t}
                    className={cx(
                      "w-[108px] border-b-[1.5px] border-ink px-3 py-3 text-center text-[11.5px] font-semibold leading-tight",
                      i === 0 ? "bg-signal/[0.06] text-signal" : "text-ink",
                    )}
                  >
                    {t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((g) => (
                <Fragment key={g.group}>
                  <tr>
                    <td
                      colSpan={TOOLS.length + 1}
                      className="border-b border-rule bg-sheet/70 px-4 pb-1.5 pt-4 font-serif text-[13px] italic text-mute"
                    >
                      {g.group}
                    </td>
                  </tr>
                  {g.items.map(([cap, marks]) => (
                    <tr key={cap}>
                      <td className="sticky left-0 border-b border-rule bg-white px-4 py-2.5 text-graphite">{cap}</td>
                      {marks.map((m, i) => (
                        <MarkCell key={i} m={m} ours={i === 0} />
                      ))}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 max-w-[820px] text-[11.5px] leading-relaxed text-mute">
          Competitor columns reflect our reading of each product&apos;s publicly described features as of October 2026, not hands-on
          testing; products change quickly.
        </p>

        <div className="mt-16 flex flex-col items-start justify-between gap-5 border-t border-ink pt-8 md:flex-row md:items-center">
          <div>
            <h2 className="font-serif text-[26px] leading-tight text-ink">Start free. Pay for the analysis, not the questions.</h2>
            <p className="mt-1 text-[13.5px] text-graphite">
              Free plan with 1,000 credits to start; Pro is $29 a month for 6,000 credits. Failed or stopped work is always refunded.
            </p>
          </div>
          <div className="flex gap-3">
            <Button tone="ink" size="md" onClick={() => onGo("pricing")}>
              See pricing
            </Button>
            <Button tone="quiet" size="md" onClick={() => onGo("guide")}>
              Read the docs
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
