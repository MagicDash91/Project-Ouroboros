"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Masthead } from "@/components/Masthead";
import { LightboxProvider, ReviewSheet, ToastProvider, useToast } from "@/components/Overlays";
import { RunBrief } from "@/components/RunBrief";
import { Book, Coins, Flow, Home as HomeIcon, Layers, MessageGrid, Spark } from "@/components/icons";
import { WorkflowView } from "@/components/views/WorkflowView";
import { AgentView } from "@/components/views/AgentView";
import { cx } from "@/components/ui";
import { ChatView } from "@/components/views/ChatView";
import { ConsoleView } from "@/components/views/ConsoleView";
import { DashboardView } from "@/components/views/DashboardView";
import { DataChatView } from "@/components/views/DataChatView";
import { DataModelsView } from "@/components/views/DataModelsView";
import { GraphView } from "@/components/views/GraphView";
import { GuideView } from "@/components/views/GuideView";
import { HomeView } from "@/components/views/HomeView";
import { PricingView } from "@/components/views/PricingView";
import { fmtCreditsShort, useBilling } from "@/lib/billing";
import { AnalyticsView, ChartsView, ContentView, FilesView, MarketingView } from "@/components/views/ReportViews";
import { DocsView, ModelLabView, MonitorView } from "@/components/views/ToolViews";
import { useRun } from "@/lib/useRun";
import type { Results } from "@/lib/types";

type Section =
  | "wire"
  | "dashboard"
  | "analytics"
  | "charts"
  | "marketing"
  | "content"
  | "files"
  | "chat"
  | "graph"
  | "lab"
  | "models"
  | "monitor"
  | "docs";

const GROUPS: { name: string; items: { key: Section; label: string }[] }[] = [
  {
    name: "Run",
    items: [
      { key: "wire", label: "Wire" },
      { key: "dashboard", label: "Dashboard" },
      { key: "analytics", label: "Analytics" },
      { key: "charts", label: "Charts" },
      { key: "marketing", label: "Marketing" },
      { key: "content", label: "Content" },
      { key: "files", label: "Files" },
    ],
  },
  {
    name: "Ask",
    items: [
      { key: "chat", label: "Conversation" },
      { key: "graph", label: "Graph" },
    ],
  },
  {
    name: "Tools",
    items: [
      { key: "models", label: "Data models" },
      { key: "lab", label: "Model lab" },
      { key: "monitor", label: "Monitoring" },
      { key: "docs", label: "Documents" },
    ],
  },
];

function counts(r: Results | null): Partial<Record<Section, number>> {
  if (!r) return {};
  return {
    dashboard: r.dashboard_id ? 1 : 0,
    analytics: r.banking_report ? 1 : 0,
    charts: r.banking_charts?.length || 0,
    marketing: r.marketing_report || r.campaign_brief ? 1 : 0,
    content: r.marketing_content_items?.length || 0,
    files: r.all_reports?.length || 0,
  };
}

type App = "home" | "analytics" | "datachat" | "agent" | "workflow" | "pricing" | "guide";

const APPS: { key: App; label: string; note: string; Icon: typeof Layers }[] = [
  { key: "home", label: "Home", note: "What the desk does and how it compares", Icon: HomeIcon },
  { key: "analytics", label: "Analytics", note: "Full analysis: agent runs, reports, dashboards", Icon: Layers },
  { key: "datachat", label: "Data chat", note: "Chat with a file or a database", Icon: MessageGrid },
  { key: "agent", label: "Agent", note: "Autonomous agent: give it a goal, it does the work", Icon: Spark },
  { key: "workflow", label: "Workflow", note: "Build automations on a canvas, by hand or by prompt", Icon: Flow },
  { key: "pricing", label: "Pricing", note: "Plans, credits and top-ups", Icon: Coins },
  { key: "guide", label: "Docs", note: "How to run, use and secure the desk", Icon: Book },
];

/** Far-left switcher between the two products that share this desk. */
function AppRail({
  app,
  onChange,
  busy,
  balance,
}: {
  app: App;
  onChange: (a: App) => void;
  busy: boolean;
  balance: number | null;
}) {
  return (
    <nav
      aria-label="Apps"
      className="flex shrink-0 gap-1 border-b border-ink bg-ink px-3 py-2 lg:w-[76px] lg:flex-col lg:gap-2 lg:border-b-0 lg:px-2 lg:py-4"
    >
      {APPS.map(({ key, label, note, Icon }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          title={note}
          aria-current={app === key ? "page" : undefined}
          className={cx(
            "relative flex items-center gap-2 rounded-[3px] px-3 py-2 text-paper/60 transition-colors hover:bg-paper/10 hover:text-paper lg:flex-col lg:gap-1.5 lg:px-1 lg:py-3",
            app === key && "bg-paper/10 text-paper",
          )}
        >
          {app === key && <span className="absolute inset-y-2 left-0 hidden w-[2px] bg-signal lg:block" />}
          <Icon size={20} />
          <span className="text-[11px] font-medium leading-none tracking-[0.02em]">{label}</span>
          {key === "pricing" && balance !== null && (
            <span className="font-mono text-[10px] leading-none text-signal" aria-label="credit balance">
              {fmtCreditsShort(balance)}
            </span>
          )}
          {key === "analytics" && busy && app !== "analytics" && (
            <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-signal" aria-label="run in progress" />
          )}
        </button>
      ))}
    </nav>
  );
}

function Desk() {
  const toast = useToast();
  const run = useRun(toast);
  const billing = useBilling();
  const [app, setApp] = useState<App>("home");
  const [section, setSection] = useState<Section>("wire");
  const [seen, setSeen] = useState<Set<Section>>(new Set<Section>(["wire"]));
  const [reviewOpen, setReviewOpen] = useState(true);
  const prevResults = useRef<Results | null>(null);

  const busy = run.status === "running" || run.status === "awaiting";
  const finished = run.status === "completed";
  const tally = useMemo(() => counts(run.results), [run.results]);

  // Fresh results: mark the result sections unseen so the index can flag them.
  useEffect(() => {
    if (run.results && run.results !== prevResults.current) {
      setSeen(new Set<Section>([section]));
      prevResults.current = run.results;
    }
  }, [run.results, section]);

  // A new review request always opens the sheet.
  useEffect(() => {
    if (run.review) setReviewOpen(true);
  }, [run.review]);

  const go = (s: Section) => {
    setSection(s);
    setSeen((prev) => new Set(prev).add(s));
  };

  return (
    <div className="flex min-h-screen flex-col lg:h-screen lg:overflow-hidden">
      <Masthead
        status={run.status}
        phases={run.phases}
        taskId={run.taskId}
        startedAt={run.startedAt}
        reviewPending={!!run.review && !reviewOpen}
        onOpenReview={() => setReviewOpen(true)}
      />

      <div className="flex flex-1 flex-col lg:min-h-0 lg:flex-row">
        <AppRail app={app} onChange={setApp} busy={busy} balance={billing.billing?.balance ?? null} />

        {app === "home" && (
          <div className="min-w-0 flex-1 lg:min-h-0">
            <HomeView onGo={setApp} />
          </div>
        )}

        {/* Stays mounted so a running task keeps updating while you look elsewhere. */}
        <div className={cx("min-w-0 flex-1 lg:min-h-0", app !== "agent" && "hidden")}>
          <AgentView />
        </div>

        {app === "workflow" && (
          <div className="min-w-0 flex-1 lg:min-h-0">
            <WorkflowView />
          </div>
        )}

        {app === "pricing" && (
          <div className="min-w-0 flex-1 lg:min-h-0">
            <PricingView
              billing={billing.billing}
              error={billing.error}
              onChange={billing.setBilling}
              onRetry={billing.refresh}
            />
          </div>
        )}

        {/* Both apps stay mounted, so a running analysis keeps streaming while you chat. */}
        <div className={cx("min-w-0 flex-1 lg:min-h-0", app !== "datachat" && "hidden")}>
          <DataChatView />
        </div>

        {app === "guide" && (
          <div className="min-w-0 flex-1 lg:min-h-0">
            <GuideView />
          </div>
        )}

      <div className={cx("grid flex-1 lg:min-h-0 lg:grid-cols-[340px_minmax(0,1fr)]", app !== "analytics" && "hidden")}>
        <aside className="border-b border-ink bg-paper lg:min-h-0 lg:border-b-0 lg:border-r">
          <RunBrief
            busy={busy}
            onRun={(req) => {
              go("wire");
              run.start(req);
            }}
          />
        </aside>

        <main className="flex min-w-0 flex-col lg:min-h-0">
          <nav className="flex shrink-0 gap-8 overflow-x-auto overflow-y-hidden border-b border-rule px-6 lg:px-10" aria-label="Sections">
            {GROUPS.map((g) => (
              <div key={g.name} className="flex shrink-0 items-stretch gap-5">
                <span className="self-center font-serif text-[13px] italic text-mute">{g.name}</span>
                {g.items.map((it) => {
                  const n = tally[it.key];
                  const fresh = !!n && !seen.has(it.key);
                  return (
                    <button
                      key={it.key}
                      onClick={() => go(it.key)}
                      aria-current={section === it.key ? "page" : undefined}
                      className={cx(
                        "relative -mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 py-3 text-[13px] transition-colors",
                        section === it.key ? "border-ink font-medium text-ink" : "border-transparent text-graphite hover:text-ink",
                      )}
                    >
                      {it.label}
                      {!!n && n > 1 && <span className="font-mono text-[10.5px] text-mute">{n}</span>}
                      {fresh && <span className="h-1.5 w-1.5 rounded-full bg-signal" aria-label="new" />}
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>

          <div className={cx("flex-1 lg:min-h-0", ["chat", "wire", "dashboard"].includes(section) ? "lg:overflow-hidden" : "overflow-y-auto")}>
            {section === "wire" && <ConsoleView logs={run.logs} running={busy} onClear={run.clearLogs} />}
            {section === "dashboard" && <DashboardView dashboardId={run.results?.dashboard_id} />}
            {section === "analytics" && <AnalyticsView results={run.results} />}
            {section === "charts" && <ChartsView results={run.results} />}
            {section === "marketing" && <MarketingView results={run.results} />}
            {section === "content" && <ContentView results={run.results} />}
            {section === "files" && <FilesView results={run.results} />}
            {section === "chat" && <ChatView taskId={run.taskId} ready={finished} />}
            {section === "graph" && <GraphView taskId={run.taskId} ready={finished} />}
            {section === "lab" && <ModelLabView />}
            {section === "models" && <DataModelsView runId={run.results?.dbt_run_id} />}
            {section === "monitor" && <MonitorView />}
            {section === "docs" && <DocsView taskId={finished ? run.taskId : null} />}
          </div>
        </main>
      </div>
      </div>

      {run.review && reviewOpen && (
        <ReviewSheet review={run.review} onDecide={run.decide} onDismiss={() => setReviewOpen(false)} />
      )}
    </div>
  );
}

export default function Home() {
  return (
    <ToastProvider>
      <LightboxProvider>
        <Desk />
      </LightboxProvider>
    </ToastProvider>
  );
}
