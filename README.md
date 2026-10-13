# Ouroboros

**An analytics and marketing desk staffed by AI agents.** Point it at any database, file or app (Google Sheets, Drive, Slack, Notion, Airtable) and it engineers the data with **dbt**, models it, builds a **Power BI-style dashboard**, writes the report and drafts the **marketing campaign** — with you approving the plan. Next to that full pipeline sit **Data chat** for quick questions, an autonomous **Agent** that browses the web and does open-ended research, and **Workflow** for repeatable, scheduled automations. Every report the desk writes opens as an **editable, presentable deck and Word document**.

Everything runs on **Claude Haiku 5.5**, with **LangGraph** and **CrewAI** for the agent teams, **FastMCP** for safe tool access, **dbt + Apache Airflow** for data engineering, **Playwright** for browsing, and a **Next.js** web app.

It isn't tied to one industry or dataset: the agents, charts and dashboards adapt to whatever is connected — retail sales, churn, fraud, credit risk, documents, or no data at all.

![Automatic dashboard](static/o9.JPG)
<sub>An Analytics run on a retail database: the automatic, filterable dashboard (KPI cards, trends, breakdowns).</sub>

---

## Contents

1. [The apps](#the-apps)
2. [How it compares](#how-it-compares)
3. [Architecture](#architecture)
4. [Analytics: the full pipeline](#analytics-the-full-pipeline)
5. [Data chat](#data-chat)
6. [Agent: autonomous tasks](#agent-autonomous-tasks)
7. [Workflow: automations on a canvas](#workflow-automations-on-a-canvas)
8. [Studio: editable decks and documents](#studio-editable-decks-and-documents)
9. [Pricing & credits](#pricing--credits)
10. [Security model](#security-model)
11. [Connecting a database](#connecting-a-database)
12. [Connecting apps](#connecting-apps)
13. [Tech stack](#tech-stack)
14. [Installation & running](#installation--running)
15. [Environment variables](#environment-variables)
16. [API reference](#api-reference)
17. [Project structure](#project-structure)
18. [Known limitations](#known-limitations)
19. [Architecture poster brief](#architecture-poster-brief)

---

## The apps

![Home page](static/o1.JPG)
<sub>The Home page: the brief in one sentence, then Start here.</sub>

<table><tr>
<td width="50%"><img src="static/o2.JPG" alt="Start here with industry kits"><br><sub>Home → Start here: pick an industry kit and try every app on a fictional company.</sub></td>
<td width="50%"><img src="static/o4.JPG" alt="Four ways to work"><br><sub>The four apps: Analytics, Data chat, Agent and Workflow, with their credit cost.</sub></td>
</tr></table>

The left rail switches between seven apps that share one backend:

| App | Use it when | You get |
|---|---|---|
| **Home** | First visit | What the desk does, the end-to-end chain, a feature comparison with other tools, pricing |
| **Analytics** | You want a full analysis of a dataset | Approved plan → dbt models + tests → forecasts / segments / classifiers → AI-written charts → automatic dashboard → PDF + PowerPoint report → marketing campaign; the report and campaign open as editable decks and Word documents with the run's charts |
| **Data chat** | You have a quick question about a file, database or app | A data overview with suggested questions, then short answers with the SQL / Python behind them, tables, charts and follow-up questions; a shared business glossary; Excel / CSV / PNG downloads; a pinboard; turn the chat into a deck or report |
| **Agent** | The task needs the web, or several sources | A plan you approve, then autonomous browsing, research (in parallel), analysis, and an answer with a conclusion and prioritised recommendations, plus a report, deck or spreadsheet you can edit and present |
| **Workflow** | You want a repeatable automation | An n8n-style canvas of 32 steps (sources incl. live app data → transforms → quality & logic → ML → AI → outputs incl. Slack / Teams alerts), built by hand or from a prompt, run once or on a schedule |
| **Pricing** | Checking your balance, plan or buying credits | Credit balance by bucket, plans, rate card, top-ups, spending controls, activity history |
| **Docs** | Learning how to use or run it | In-app guide: running locally, each app, connecting databases, security, API, limits |

---

## How it compares

Most tools cover one or two steps; this desk covers the chain from data engineering to the campaign that acts on it.

![Comparison table](static/o6.JPG)
<sub>The comparison table on the Home page (capabilities by category).</sub>

![Comparison table, continued](static/o7.JPG)
<sub>The comparison continued: outputs, trust & security, and autonomy.</sub>

| Capability | This desk | Julius AI | Manus AI | ChatGPT data analysis | Power BI Copilot | Databricks Genie |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Chat with files or a database | ✅ | ✅ | ½ | ½ | ✅ | ✅ |
| Full multi-step analysis from one brief | ✅ | — | ✅ | — | — | — |
| Data engineering (dbt models + tests) | ✅ | — | — | — | — | ½ |
| Scheduled pipelines (Airflow) | ✅ | — | — | — | ½ | ✅ |
| Automatic interactive dashboard | ✅ | — | ½ | — | ✅ | ✅ |
| Marketing strategy and content from the insights | ✅ | — | ✅ | ½ | — | — |
| Personal data masked before the AI sees it | ✅ | — | — | — | ½ | ½ |
| Browses the web and acts on its own | ✅ | — | ✅ | ✅ | — | — |
| Parallel researcher agents | ✅ | — | ✅ | — | — | — |
| Agent can query your database safely | ✅ | — | — | — | — | ½ |

✅ yes · ½ partly · — no. Competitor columns reflect publicly described features as of October 2026, not hands-on testing. The full table is on the Home page.

---

## Architecture

![One brief, the whole chain](static/o3.JPG)
<sub>What Ouroboros is: one brief runs the whole chain (plan, engineer, model, show, report, act).</sub>

```mermaid
flowchart LR
    U([User]) --> FE[Next.js web app<br/>Home · Analytics · Data chat · Agent · Workflow · Pricing · Docs]
    FE <-->|REST + SSE + polling| API[FastAPI backend :8002]

    subgraph DATA[Data layer]
        CONN[Connection normaliser<br/>Postgres · MySQL · SQL Server · Oracle<br/>Redshift · BigQuery · Snowflake · DuckDB · SQLite]
        UP[Uploads: CSV · Excel · Parquet · JSON · PDF · Word · PPTX]
        APPS[App connectors<br/>Sheets · Drive · Slack · Notion · Airtable · URL]
        DBT[dbt: staging → marts + tests]
        AF[Airflow in Docker<br/>daily dbt build + quality gate]
    end

    subgraph AN[Analytics — Claude Haiku 5.5]
        LG1[LangGraph plan] --> HITL{Human review} --> CA[Analytics crew · 5 agents]
        CA --> LG2[LangGraph marketing plan] --> CM[Marketing crew · 4 agents]
    end

    subgraph SAFE[Safe tool layer]
        MCP[Read-only FastMCP server<br/>describe_data · run_sql · run_python]
        SBX[Sandboxed Python kernel]
        GUARD[LLM guard: PII masking ·<br/>injection screening · output sanitising]
    end

    subgraph AG[Agent]
        PLAN[Plan → you approve] --> LOOP[Tool loop:<br/>search · browse · files · Python · SQL]
        LOOP --> WIDE[Parallel researchers ×8]
    end

    API --> CONN --> LG1
    UP --> CONN
    APPS --> UP
    API --> WF[Workflow engine<br/>32 steps · schedules · alerts]
    HITL --> DBT --> CA
    AF -. rebuilds daily .-> DBT
    API --> DC[Data chat agent] --> MCP
    API --> PLAN
    LOOP --> MCP
    MCP --> SBX
    MCP --> GUARD
    API --> BILL[(Credit wallet)]

    CA --> OUT[Dashboard · charts · PDF / PPTX · knowledge graph]
    CM --> OUT
    LOOP --> DEL[Report · deck · spreadsheet]
    OUT --> STU[Studio: editable deck + document<br/>AI edits · versions · pptx / docx / pdf]
    DEL --> STU
    DC --> STU
```

---

## Analytics: the full pipeline

### How a run works

![The wire](static/o8.JPG)
<sub>The wire: a live log of the run, from LangGraph planning and your approval to the CrewAI teams and dbt.</sub>

1. **Brief & sources** — describe what you want to know; optionally connect a database (with schema), upload files, and fill in the marketing fields.
2. **Connect** — the connection string is normalised for its provider.
3. **Strategic plan** — a LangGraph planner drafts the analysis plan and a preliminary report.
4. **Human review** — approve or abort (auto-approves after 10 minutes). Aborted runs are refunded.
5. **dbt modelling** — on PostgreSQL, Claude designs staging + mart models with tests and `dbt build` materialises them in `uaa_staging` / `uaa_marts`. Raw data is never modified.
6. **Analytics crew** — profiles the marts, picks the method the data supports, writes problem-specific charts, the insight report, PDF and PowerPoint.
7. **Automatic dashboard** — designed on the main mart, ready in the **Dashboard** tab.
8. **Marketing** — a LangGraph plan plus a 4-agent crew produce the campaign brief, research, strategy, ad copy and social posts.
9. **Explore** — chat with the results, open the knowledge graph, inspect dbt lineage, schedule refreshes with Airflow.
10. **Edit & present** — *Edit this report* (Analytics report page) and *Edit this campaign* (Campaign brief page) open the [Studio](#studio-editable-decks-and-documents) with the run's own charts. Both editable versions are prepared in the background as soon as the run finishes (also when a later stage failed).

### Agent teams (CrewAI on Claude Haiku 5.5)

| Analytics crew | Responsibility |
|---|---|
| Senior Data Engineer | Discovers tables, profiles the tested dbt marts (cleans raw tables only when dbt isn't available) |
| Senior Data Scientist | Time-series forecast for sales over time, classifier when an outcome column exists, segmentation for customer data |
| Data Preprocessing Analyst | Numeric version of the data for correlation analysis |
| Senior Data Analyst | Problem-driven charts, business insight report, PDF and PowerPoint |
| Chief Data Officer | Executive summary and marketing hand-off |

| Marketing crew | Responsibility |
|---|---|
| Market Researcher | Market, competitor, audience and trend research (Tavily, Exa) |
| Campaign Strategist | Strategy, content calendar, KPIs, budget allocation |
| Content Creator | Ad copy, social posts, content report (posters optional) |
| Chief Marketing Officer | Final campaign brief |

**Proof of work:** guardrails reject agent answers that aren't backed by successful tool results; after retries the answer is stamped UNVERIFIED instead of failing the run.

### Result tabs

| Group | Tabs |
|---|---|
| Run | **Wire** (live log) · **Dashboard** · **Analytics** (report) · **Charts** · **Marketing** · **Content** · **Files** |
| Ask | **Conversation** (follow-up questions, charts, document retrieval) · **Graph** (Zep knowledge graph) |
| Tools | **Data models** (dbt lineage, SQL, tests, Airflow) · **Model lab** (scoring, SHAP drivers, what-if) · **Monitoring** (drift alerts) · **Documents** (RAG Q&A) |

<table><tr>
<td width="50%"><img src="static/o10.JPG" alt="Analytics report"><br><sub>Analytics report: executive briefing, editable as a deck or Word document, with every export on the right.</sub></td>
<td width="50%"><img src="static/o11.JPG" alt="Figures with readings"><br><sub>Each figure comes with the model's reading of the plotted data and what to do about it.</sub></td>
</tr></table>

<table><tr>
<td width="50%"><img src="static/o12.JPG" alt="Chart room"><br><sub>Chart room: every AI-written chart of the run.</sub></td>
<td width="50%"><img src="static/o16.JPG" alt="Conversation"><br><sub>Conversation: ask the desk about this run.</sub></td>
</tr></table>

<table><tr>
<td width="50%"><img src="static/o13.JPG" alt="Campaign brief"><br><sub>Marketing: the CDO's campaign brief, written from the analysts' findings.</sub></td>
<td width="50%"><img src="static/o14.JPG" alt="Content"><br><sub>Content: social posts and ad copy for Instagram, LinkedIn, Google and Meta.</sub></td>
</tr></table>

![Ad copy](static/o15.JPG)
<sub>Content, continued: more posts and the ad copy for Google, Meta and LinkedIn.</sub>

<table><tr>
<td width="50%"><img src="static/o17.JPG" alt="Knowledge graph"><br><sub>Knowledge graph (Zep): problems, segments, competitors and web intelligence, linked.</sub></td>
<td width="50%"><img src="static/o18.JPG" alt="What the graph says"><br><sub>What the graph says: the causal chain and the leading indicators to watch.</sub></td>
</tr></table>

### dbt + Airflow

- **dbt (`tools/dbt_builder.py`)** — Claude designs sources, `stg_*` views and `fct_*`/`dim_*` marts with column docs and tests (`not_null`, `unique`, `accepted_values`, `relationships`). A SQL guard allows only single `SELECT`s with `source()` / `ref()` / `config()` Jinja; failing models get one repair attempt from dbt's own error output. The password reaches dbt only via `env_var()`.
- **Airflow (`tools/airflow_builder.py`, `airflow/`)** — Docker Compose with `apache/airflow:3.2.1` + dbt, UI at <http://localhost:8085>. DAG `uaa_dbt_pipeline` runs daily: `dbt_build` → `quality_gate`. The backend ingests dbt's artifacts from the shared `dbt/uaa/target/` into the build history.

<table><tr>
<td width="50%"><img src="static/o19.JPG" alt="dbt lineage"><br><sub>Data models: dbt lineage from sources to staging to marts, 38/38 tests passed.</sub></td>
<td width="50%"><img src="static/o20.JPG" alt="dbt tests and Airflow"><br><sub>dbt tests per model, build history and the Airflow schedule.</sub></td>
</tr></table>

### Automatic dashboard

- One Claude call (~4k tokens) designs 3–6 KPI cards, 4–8 visuals and up to 4 slicers, with the currency detected from the data (e.g. IDR → "Rp").
- Every tile is a read-only SQL query; filters are bound parameters, so **filtering and refreshing use no LLM call**.
- Power BI look: grey canvas, white tiles, Power BI palette, compact K/M/bn numbers, click-to-cross-filter, filters pane, page tabs, **+** to design another page.

### AI-written charts

- `tools/chart_codegen.py` — Claude chooses ~6 charts for the problem and writes the code in the most suitable library (Plotly, Altair, Bokeh, Matplotlib, Seaborn), with one batched repair call and finding-style headlines.
- `tools/chart_runner.py` — separate time-limited process, no secrets in its environment, allow-listed imports, no file / OS / network / eval / dunder access.

---

## Data chat

Julius-style chat with a file or a database. Every answer leads with the conclusion and shows the SQL or Python behind it.

![Data chat on a database](static/o21.JPG)
<sub>Data chat on a Supabase database: the tables (personal-data columns flagged PII), the steps the analyst ran, and the answer.</sub>

<table><tr>
<td width="50%"><img src="static/o22.JPG" alt="Chart and caveats"><br><sub>Answers end with caveats and a chart you can download as PNG or pin.</sub></td>
<td width="50%"><img src="static/o23.JPG" alt="Driver analysis"><br><sub>Answer, then what the data shows, the insight and the recommended next step.</sub></td>
</tr></table>

- **Sources:** upload CSV · TSV · XLSX · XLS · Parquet · Feather · JSON · JSONL (up to 200 MB each), or connect any supported database.
- **Data overview:** when a chat opens, every table is profiled in the sandbox (rows, missing values, date ranges, top values) and one Claude call writes a short summary, data-quality notes and six questions tailored to the columns (built once per chat, free).
- **Follow-ups:** each answer ends with three suggested next questions, shown as buttons (parsed from a `FOLLOW_UPS:` line; no extra AI call).
- **"Why did this change?":** ask *why did revenue drop in September?* and the agent calls `explain_change()` (`tools/insights.py`, preloaded in the sandbox). It splits the change in a total between two periods across every category column, ranks the segments that moved differently from the overall trend, drills one level into the biggest one and draws a waterfall: *"+30%: 98% of the rise is Garut, mostly working-capital loans"*. It handles months, quarters, years, date ranges and year-on-year; it skips IDs, free text, masked personal data and duplicate columns (store vs store_id), and flags incomplete periods and periods of different length. The numbers are computed in Python, not by the AI.
- **Forecasts and what-if:** `forecast()` fits Holt-Winters (damped trend, plus seasonality when there are two full years), returns an 80% range from 1,000 simulated paths and a backtest error, and leaves out an unfinished first or last period. For *what if we raise prices 5%?* the agent turns the assumption into a % change (1.05 × 0.96 = +0.8%) and draws the scenario line next to the baseline, labelling its assumptions.
- **Business glossary:** shared definitions (e.g. *big order = revenue above 500,000*) added to every question; definitions that look like prompt injection are rejected. `GET/PUT /api/datachat/glossary`.
- **Exports:** the full result behind a table (up to 200k rows, kept in the chat's private folder) downloads as Excel or CSV; Plotly charts download as PNG (rendered from the saved figure spec with Kaleido).
- **Pinboard:** pin any chart or table; **Refresh** replays the steps that produced it on the current data (no AI call). `GET /api/datachat/pins`, `POST …/sessions/{id}/pins`, `POST /api/datachat/pins/{id}/refresh`.
- **Report, deck or Word:** *Turn this chat into* opens the Studio editors with every question and answer, its tables and charts; when the chat grows, the editors offer *Update from chat* (the current version stays in History).
- **Agent:** a LangChain tool-calling agent on Claude whose tools come **only** from the read-only FastMCP server `features/datachat_mcp.py`:

| Tool | What it does |
|---|---|
| `describe_data` | Datasets, columns, types and which columns are masked |
| `run_sql` | One parser-validated `SELECT`, run in a `READ ONLY` transaction (30 s timeout, 200k-row cap); the result becomes a DataFrame |
| `run_python` | pandas / Plotly in a persistent sandboxed kernel (`tools/py_kernel.py`); variables persist between questions |

- **Speed:** the first question in a new chat is the slowest (the backend loads its libraries and starts the session's sandbox); follow-ups take about 15–30 seconds.
- Up to 3 sandboxes run at once; each chat is limited to 20 questions per 5 minutes.

---

## Agent: autonomous tasks

A Manus-style agent for business work: give it a goal, approve the plan, and it works on its own.

![Agent answer](static/o24.JPG)
<sub>An Agent task: a live price comparison of three milk-powder brands across Indonesian online stores.</sub>

<table><tr>
<td width="50%"><img src="static/o25.JPG" alt="Recommendations"><br><sub>Every answer ends with prioritised recommendations, expected impact, and risks and caveats.</sub></td>
<td width="50%"><img src="static/o26.JPG" alt="Activity and deliverables"><br><sub>Sources, the 19-step activity log, the checklist and the deliverables (Excel, Markdown, PDF, PowerPoint).</sub></td>
</tr></table>

**Flow:** goal → Claude drafts a plan (free) → you edit steps and research items, and see the exact cost → **Approve & run** → live activity, checklist, researchers, files and sources → a structured answer plus deliverables. You can stop a task at any time (refunded).

**The answer** always has the same sections: the direct answer with its key numbers → *Key findings* → *Conclusion* (what the findings mean for your decision) → *Recommendations* (3–6, sorted by priority, each with timing, the finding behind it and the expected impact) → *Risks and caveats* → *Sources*. Headings follow your language (English or Indonesian). Reports must follow the same structure: `create_deliverable` rejects a report without a Conclusion and a Recommendations section, and the agent adds them.

**Bring your own data:** attach files or app imports (*Bring in data from an app*); they land in the workspace under `inputs/` and the plan starts from them.

| Tool | What it does |
|---|---|
| `update_todo` | The agent keeps a checklist and rewrites it as it works, keeping the goal in focus over long tasks |
| `web_search` | Tavily web search |
| `browse` | A real headless browser (Playwright). Each page opens in its own process with a 45 s hard limit; the full text is saved to the workspace and only an excerpt enters the context |
| `read_file` · `write_file` · `list_files` | The task workspace: page text, findings and tables live in files so long tasks lose nothing |
| `load_into_python` · `run_python` | Calculations and charts in the same sandbox as Data chat |
| `describe_database` · `run_sql` | Read-only SQL with personal data masked (only when a database is connected) |
| `wide_research` | Up to **8 parallel researcher agents** (4 at a time), one per item — each a full agent with its own context and browser; findings come back as files |
| `create_deliverable` | PDF report + PowerPoint deck + Markdown (must include Conclusion and Recommendations), or an Excel workbook from a CSV |
| `finish` | The final answer, as structured fields: answer, key findings, conclusion, recommendations, risks, sources |

**How it stays efficient** (lessons published by Manus): a stable, cached system prompt and tool list (~97% of input tokens served from cache in testing); the tool set never changes during a task; errors stay in context so the agent adapts; old tool results are compacted to stubs that point to the saved files.

**Measured:** a 3-brand price comparison finished in under 4 minutes (11 model calls); a 4-company research task with 4 parallel researchers finished in about 3 minutes and produced an Excel sheet, PDF, deck and Markdown.

**Good tasks:** competitor price checks across online stores; market or competitor research on several companies at once; combining web research with your own sales data.

Note: some sites (e.g. Shopee, Blibli) block automated browsers — the agent notices and uses other sources, and marks lower-confidence figures.

Every finished task can be edited and presented in the [Studio](#studio-editable-decks-and-documents): from its report, or — when it only produced a spreadsheet — from its final answer plus the spreadsheet's data.

---

## Workflow: automations on a canvas

![Workflow canvas](static/o29.JPG)
<sub>A workflow on the canvas: file → formula → group & summarise → chart, plus a forecast and AI insights; runs on the right.</sub>

An n8n-style builder (React Flow) where every step is one of the desk's own abilities. Build by dragging steps and connecting them, or **describe the workflow and Claude builds it** — and later edits it ("also export to Excel", "run every Monday").

| Group | Steps |
|---|---|
| Sources | File (CSV, Excel, Parquet, JSON) · Database query (one parser-validated, read-only SELECT) · Web search · App data (Google Sheets, Drive, Slack, Notion, Airtable or a file URL, fetched fresh on every run) |
| Transform | Filter rows · Keep / drop columns · Rename columns · Clean data · Formula column (restricted expressions) · Group & summarise · Sort & limit · Join (left + right inputs) · Append tables · Pivot · Unpivot · Date tools (year, quarter, month, week, weekday, period start, days since) · Calculate (running total, % change, difference, moving average, rank, share of total; per group) · Bucket values |
| Quality & logic | Data quality check (not_null, unique, between, allowed, min_rows, max_age_days; stop or continue on failure) · Condition (continue only if a measure passes; otherwise downstream steps are skipped, not failed) |
| Machine learning | Forecast (Holt-Winters with backtest error) · Predict (classifier / regressor with key drivers) · Segment (K-Means with profiles) · Anomaly detection (rolling z-score, IQR or Isolation Forest) |
| AI | AI insights (personal data masked) · AI classify (sentiment, your categories, or an extracted field per row; personal data redacted; up to 500 rows) · Agent task (runs the autonomous Agent) |
| Outputs | Chart (interactive Plotly) · Report (PDF + PowerPoint + Markdown) · Export (Excel / CSV) · Send alert (Slack, Microsoft Teams or a webhook; https and public addresses only) |

Example: *every morning → App data (Google Sheet) → Data quality check → Calculate % change → Condition (drop below -10%) → Send alert to Slack.* Tokens and webhook URLs are masked in every API response, like database passwords.

- **Engine (`features/workflow.py`):** topological execution with branches and merges, loop detection, and a failed step skipping only what depends on it. Every step's rows, preview table, charts, text, metrics, files and timing are kept per run and shown on the canvas.
- **AI builder:** one Claude call with the step catalog and the uploaded files' real column names returns the graph, which is validated (known steps and fields only, no loops) and laid out automatically. It never invents connection strings; a schedule it proposes is saved switched off.
- **Schedules:** hourly, daily or weekly runs from a background thread.
- **Speed:** a 7-step sales workflow (file → revenue → by region → chart, forecast → AI insights → PDF report) runs in about 45 seconds; building it from a prompt takes about 4 seconds.
- **Example from one prompt:** "Every morning, pull our sales Google Sheet, check there are no blank order IDs, compute the day-over-day % change of revenue, and if revenue dropped by more than 10% send an alert to our Slack channel" → App data → Data quality check → Date tools → Calculate → Condition → Send alert, with a daily 08:00 schedule saved switched off and the link / webhook left for you to fill in.

---

## Studio: editable decks and documents

<table><tr>
<td width="50%"><img src="static/o27.JPG" alt="Deck editor"><br><sub>The deck editor: layouts, speaker notes, Ask AI for one slide or everything, brand, history, export to .pptx, present.</sub></td>
<td width="50%"><img src="static/o28.JPG" alt="Document editor"><br><sub>The document editor: click any block to edit or ask the AI; export to Word or PDF.</sub></td>
</tr></table>

Every report the desk writes can be edited, presented and exported (`features/studio.py`, `frontend/components/studio/`).

| Source | Where | Built from |
|---|---|---|
| Agent task | Agent → *Edit the result* | The task's report, or its final answer + spreadsheet data when it made no report |
| Analytics run | Analytics report page · Campaign brief page | The run's analytics report (with the run's own chart images) · its marketing report or campaign brief |
| Data chat | *Turn this chat into* | Every question and answer, with its tables and charts (Plotly charts rendered to PNG) |

- **Deck:** 9 layouts (title, section, bullets, two columns, chart, table, big number, quote, chart image), laid out by Claude on first open and always ending with a Conclusion and a Recommendations slide; click any text to edit, reorder / duplicate / add slides, edit chart data in a grid, speaker notes, full-screen **Present** mode (← →, N for notes). A slide the model leaves empty is filled from the matching report section.
- **Document:** headings, text, bullets, numbered lists, tables, charts, chart images and quotes; add, convert, move and delete blocks.
- **Ask AI:** change one slide / block or everything ("make it shorter", "turn this table into a chart", "split into two slides", "translate to Bahasa Indonesia") — 3 credits, refunded on failure. Every AI edit is its own version.
- **Exports** are built from the edited version: **.pptx** with native, editable charts and tables and speaker notes; **.docx**; **PDF**.
- **History:** autosave with optimistic versioning (`base_version` → 409 on conflict), 30 versions, restore any of them or start over from the source. When the source has grown (a chat with new answers), the editor offers *Update from chat*.
- **Images** may only point at charts the platform produced under `outputs/`; anything else is dropped on save.
- Storage: `data/agent/<task>/studio/`, `data/studio/runs/<run>/<report>/`, `data/datachat/<chat>/studio/`.
- **Brand kits** (`features/brand.py`, *Brand* menu in the editors): name, accent / dark / background / text colours, heading and body fonts, logo (PNG/JPG ≤ 2 MB) and footer text; one kit can be the default for new decks. Applied live on screen and in every export (logo on the title slide and every content slide, footer, fonts and colours in .pptx / .docx; colours, logo and footer in PDF with built-in fonts).
- **Share links** (`features/share.py`, *Share* in the editors and on the Pinboard): a read-only link to the latest saved version at `/share/<token>`, optionally expiring (1–90 days) and with comments (name + text, rate-limited, never sent to an AI). The token is the permission; links can be turned off at any time. The app runs on your computer, so links work for people who can reach it — on the same network the dialog shows your LAN address (allow Node.js through Windows Firewall on private networks if needed).

---

## Pricing & credits

![Pricing](static/o30.JPG)
<sub>Pricing: the credit balance by bucket, and the plans (monthly or annual, USD or IDR).</sub>

Everything is paid for with **credits** (1 credit = $0.01 / Rp 159 at top-up price; plan credits cost less). Plans, packs and action costs live in ONE file, `pricing.json`, served by `/api/billing` so the backend and the UI never disagree.

| Plan | Price | Credits |
|---|---|---|
| Free | $0 | 1,000 at signup + 150 / month |
| Starter | $12 / month | 1,500 / month |
| Pro | $29 / month | 6,000 / month |
| Team | $149 / month | 35,000 / month, shared, 5 seats |
| Enterprise | By contract | Contracted |

| Action | Credits |
|---|---|
| Analytics run | 900 |
| Data chat question | 5 |
| Agent task (8 web searches included) | 100, then 10 per extra search |
| Parallel researcher (≤4 searches) | 40 |
| Workflow step: Web search · AI insights · Report with AI text · AI classify | 10 · 2 · 5 · 5 per run (other steps free) |
| AI edit of a deck or document (Studio) | 3 |
| Extra dashboard page · Model lab call · Document Q&A | 5 · 2 · 3 |

Free: planning (Analytics and Agent), dashboard filtering and refreshing, building and editing workflows with AI, deterministic workflow steps, editing / presenting / exporting decks and documents by hand, the Data chat overview, follow-ups and pinboard refreshes.

Top-ups (never expire): Small 1,000 / $10 · Medium 5,000 / $45 · Large 20,000 / $160. Annual plans: pay 10 months, get 12.

- Credits are spent rollover → plan → free monthly → signup → top-up, soonest-expiring first; up to 50% of a paid plan's monthly credits roll over one month.
- Work is charged when it starts and **refunded automatically** (to the bucket it came from) if it fails, is aborted at review, is stopped, or is blocked by security screening. Workflows charge each paid step as it runs.
- With too few credits the request is refused with HTTP 402 and nothing is charged — unless **auto top-up** is on (buys the smallest pack to stay above 200 credits). Top-ups per period stop at the **spend cap** (default 2× plan price, $20 on Free; `PUT /api/billing/settings`).
- Set `BILLING_ENFORCE=false` to record usage without blocking.
- **Checkout is a demo:** choosing a plan or buying a pack adds credits without taking payment. Real payments (Stripe / Xendit / Midtrans) must grant credits only from a verified webhook. The wallet and its ledger live in `data/billing/wallet.json`; an old token wallet is archived to `wallet_tokens_archive.json`.

---

## Security model

![Built to be trusted](static/o5.JPG)
<sub>How the Home page explains the trust model, and the databases and apps it connects to.</sub>

**Read-only by construction**
- Data chat and the Agent reach data only through the read-only FastMCP server. Every SQL statement is parsed (sqlglot) and rejected unless it is a single `SELECT` — no writes, DDL, `SELECT INTO`, row locks, multiple statements, dangerous functions (`pg_sleep`, `dblink`, `pg_read_file`…) or credential/system tables (Supabase `auth`/`vault`, `pg_authid`…) — then runs in a `READ ONLY` transaction with a statement timeout.
- Analytics agent SQL, NL→SQL and dashboard queries are SELECT-only; dbt never modifies raw tables.
- AI-written code (charts, Data chat, Agent) runs in separate sandboxed processes: no file, network or OS access, no secrets in the environment.

**Personal data**
- Columns holding names, emails, phone numbers, IDs or addresses are **pseudonymised (HMAC) before the model sees them**; SQL aliases are traced, so `SELECT email AS x` stays masked. Free text in results and messages is redacted.

**Prompt injection & leaks**
- Messages are screened for injection, credential requests and re-identification attempts before reaching the model.
- Tool output, web pages and search results are fenced as untrusted data; planted instructions are flagged and ignored.
- Answers are checked for system-prompt leaks (canary token) and stripped of link/image exfiltration; Agent answers may only link to pages the agent actually visited.

**Data chat, Studio and Workflow**
- Glossary definitions are screened for prompt injection before they are added to the analyst's instructions.
- Full result tables for downloads live in each chat's private `data/` folder; only charts are under the public `outputs/`.
- Studio images may only reference charts the platform produced; Workflow alerts post only to `https://` public addresses (SSRF guard, no redirects); workflow tokens and webhook URLs are masked in every API response, like database passwords.
- AI classify redacts personal data before sending text to Claude.

**Agent-specific**
- No tools that send, post, buy, sign up or delete; it never fills forms or logs in.
- The browser refuses private, loopback, link-local and cloud-metadata addresses, including on redirects (SSRF protection), and runs without the backend's API keys.

**Operations**
- Every Data chat turn is audit-logged to `data/audit/datachat_audit.jsonl` (flags, tools, timing and a message hash — never the content); Data chat is rate-limited.
- One small shared connection pool per database (protects poolers such as Supabase's 15-client limit).
- Secrets stay in `.env` / `airflow/.env`; connection passwords are never returned by the API. `data/` is private; only `outputs/` is served.

---

## Connecting a database

Paste the connection string your provider gives you, optionally set a schema, and press **Test connection** — it shows engine, provider, schemas and tables, and explains failures in plain language.

| Provider | Example |
|---|---|
| Supabase | `postgresql://postgres.<project-ref>:PASS@aws-0-<region>.pooler.supabase.com:5432/postgres` |
| Neon | `postgresql://user:pass@ep-xxx.region.aws.neon.tech/db` |
| AWS RDS / Aurora | `postgresql://admin:pass@db.xxxx.us-east-1.rds.amazonaws.com:5432/sales` |
| Amazon Redshift | `redshift://user:pass@cluster.xxxx.us-east-1.redshift.amazonaws.com:5439/dev` |
| GCP Cloud SQL | `postgresql://postgres:pass@<public-ip>:5432/analytics` |
| Google BigQuery | `bigquery://my-gcp-project/my_dataset` (credentials via `GOOGLE_APPLICATION_CREDENTIALS`) |
| Azure PostgreSQL | `postgresql://user:pass@server.postgres.database.azure.com:5432/postgres` |
| Azure SQL | `Server=tcp:server.database.windows.net,1433;Database=sales;User ID=admin;Password=…;` |
| Snowflake | `snowflake://user:pass@account/DATABASE/SCHEMA?warehouse=WH` |
| MySQL / MariaDB | `mysql://user:pass@host:3306/shop` |
| Local | `postgresql://postgres:pass@localhost:5432/mydb` · `sqlite:///C:/data/shop.db` |

JDBC strings and driver-less schemes are converted automatically; SSL is added for managed cloud Postgres hosts.

**Supabase:** the direct host `db.<project>.supabase.co` is IPv6-only and won't resolve on most IPv4 networks — use the **Session pooler** URI from *Supabase → Connect*. Note the user is `postgres.<project-ref>`, not `postgres`.

| Error | Fix |
|---|---|
| *Can't reach the server* | Wrong host, or an IPv6-only host — use the pooler URI |
| *Tenant or user not found* | Wrong pooler region, or `.<project-ref>` missing from the user |
| *Password authentication failed* | Reset the database password and update the URI |

dbt modelling requires PostgreSQL; every other feature works with all engines above.

---

## Connecting apps

All four apps import data straight from the tools a team already uses: the Analytics brief (*From an app*), Data chat (*Connect an app*), the Agent (*Bring in data from an app*) and Workflow (*Import from an app*, side panel or Upload step). `features/connectors.py` fetches it and hands it to the same code path as an upload: tables go into SQLite for Analytics, into the Data chat sandbox, into the Agent's workspace under `inputs/` (the plan and agent are told to start from them), or into the workflow's files; documents from Drive become context for Analytics runs and Agent tasks (as extracted text).

| App | Paste | Becomes | Access |
|---|---|---|---|
| Google Sheets | Sheet link (the tab in the link is imported) | Table | Link-shared: nothing. Private: service account |
| Google Drive | File link | CSV / Excel / JSON / Parquet → table; Docs, Slides, PDF, Word → document | Same as Sheets |
| Slack | `#channel` or channel link, 7 days – 1 year | One row per message: timestamp, author, text, type, replies, reactions, files | Bot token `xoxb-…` |
| Notion | Database link | One row per page, one column per property | Integration secret |
| Airtable | Table link (a view in the link filters it) | One row per record | Personal access token |
| File URL | Direct link to a file | Table or document | None; private and internal addresses refused (SSRF), every redirect re-checked |

Tokens are pasted per import (never stored) or set on the server as `SLACK_BOT_TOKEN`, `NOTION_TOKEN`, `AIRTABLE_TOKEN`; `GET /api/connectors` reports which are configured without revealing them. Private Google files use the service-account key in `GOOGLE_APPLICATION_CREDENTIALS` (share the file with the account's email). Limits: 100 MB per file, 200,000 rows per app table. An import is a snapshot; import again to refresh.

**Sign in instead of tokens (`features/oauth.py`):** *Connect Google* / *Connect Slack* in the connector picker opens the provider's consent page; afterwards Sheets / Drive read your own private files and Slack reads the channels its bot is in, with no pasted tokens. One-time setup: create a Google OAuth client (Web application; redirect URI `http://localhost:8002/api/oauth/google/callback`; enable the Drive and Sheets APIs) and/or a Slack app (redirect URL `http://localhost:8002/api/oauth/slack/callback`, bot scopes below), then set `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` and `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET`. Tokens are encrypted at rest (`data/oauth/`); without user accounts a connection is shared by everyone using the server.

**Slack app scopes:** `channels:history`, `channels:read`, `groups:history`, `groups:read`, `users:read`; invite the bot to each channel. **Notion:** add the integration under the database's ••• → *Connections*. **Airtable:** token scope `data.records:read` with access to the base.

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14 (App Router), React 18, TypeScript, Tailwind CSS 3; SVG Power BI-style visuals; vis-network |
| Backend | FastAPI + Uvicorn (port 8002), Server-Sent Events, Pydantic |
| LLM | Anthropic **Claude Haiku 5.5** (`anthropic` SDK with prompt caching, `langchain-anthropic`, CrewAI native provider) |
| Planning & agents | LangGraph (two 5-node planners), CrewAI 1.9, LangChain tool-calling agent, custom Agent loop |
| Tool protocol | FastMCP (read-only MCP server for Data chat and the Agent) |
| Web | Tavily (search), Playwright (headless Chromium / Chrome / Edge) |
| Data engineering | dbt-core 1.11 + dbt-postgres; Apache Airflow 3.2 (Docker Compose) |
| Databases | SQLAlchemy 2 with psycopg2, PyMySQL, pymssql, oracledb, sqlalchemy-redshift, sqlalchemy-bigquery, snowflake-sqlalchemy, duckdb-engine, SQLite |
| SQL safety | sqlglot (parser-based validation) |
| ML / analytics | pandas, NumPy, scikit-learn, statsmodels, SHAP, joblib |
| Charts | Plotly (+ Kaleido), Altair, Bokeh, Matplotlib, Seaborn |
| Retrieval & graph | sentence-transformers + FAISS (TF-IDF fallback); Zep Cloud + Exa |
| Reports | ReportLab (PDF), python-pptx (PowerPoint), openpyxl (Excel), Markdown |
| Observability | LangSmith (optional) |

---

## Installation & running

**1. Python backend** (Python 3.12)

```bash
python -m venv venv
venv\Scripts\activate            # macOS/Linux: source venv/bin/activate
pip install -r requirements.txt
pip install -r requirements-optional.txt      # optional: SQL Server, Oracle, Snowflake, BigQuery, Redshift, DuckDB drivers
python -m playwright install chromium         # optional: the Agent falls back to installed Chrome/Edge
```

Then copy `.env.example` to `.env` and fill in your keys.

**2. Configure and start the API** — create `.env` (see below), then:

```bash
python main.py                    # http://localhost:8002 · interactive API docs at /docs
```

**3. Frontend** — in a second terminal:

```bash
cd frontend
npm install
npm run dev                       # http://localhost:3010
```

The frontend calls the backend at `http://localhost:8002` (override with `NEXT_PUBLIC_BACKEND_URL`). Restart the backend after pulling new code — it doesn't auto-reload.

**First run: industry kits.** The Home page's **Start here** panel lets you pick an industry and try every app on a fictional sample company (`features/kits.py`; data generated on first use into `data/samples/`, no database or file needed):

| Kit | Company | Data | Patterns to find |
|---|---|---|---|
| Food & beverage | Kopi Nusantara | 2025 orders, customers, campaigns (8 cities, 5 channels) | Ramadan shifts sales to GoFood; 11.11 / 12.12 spikes; online share 35% → 58% |
| Retail | Pasar Raya Mart | daily sales per store × category, 2024-2025 (10 stores) | Lebaran rush; payday weeks; QRIS adoption; a competitor hits Bekasi Timur; a new Malang store |
| Banking | BPR Sejahtera Makmur | 6,500 loans with collectibility + monthly portfolio by branch × product, 2023-2025 | a Garut dry season more than doubles its NPL; consumer loans sour after Lebaran |
| Marketing | Batik Lestari | daily results per campaign on 5 channels, 2025 | TikTok gets cheaper; Meta costs spike at Harbolnas; Google Search fatigue; Hari Batik burst |

Each kit comes with **metric definitions** (NPL ratio, ROAS, like-for-like sales…) and **six questions** (including a *why* and a *forecast / what-if* question) that travel with its Data chat only, so your own glossary is untouched; an **Analytics brief**, an **Agent goal**, and a ready-made **Workflow** whose AI step reads a compact summary table. Questions answered on a kit chat use these definitions.

**4. Airflow (optional, needs Docker Desktop)** — generate the setup from *Data models* (or `POST /api/airflow/setup`), then:

```bash
cd airflow
docker compose up -d --build      # UI http://localhost:8085 (user uaa, password in airflow/.env)
```

---

The app also has its own **Docs** page (rail → Docs) with guides for every app:

![Built-in docs](static/o31.JPG)
<sub>Docs → Using Data chat, including the guide to why-did-it-change, forecasts and what-if.</sub>

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Claude API key |
| `ANTHROPIC_MODEL` | | Defaults to `claude-haiku-5-5` |
| `TAVILY_API_KEY` | for Agent / marketing | Web search |
| `POSTGRES_HOST` / `PORT` / `DB` / `USER` / `PASSWORD` | | Default database when no connection string is given |
| `EXA_API_KEY` · `ZEP_API_KEY` | | Knowledge graph enrichment / storage |
| `GOOGLE_API_KEY` | | Only for poster images |
| `ENABLE_POSTER_GENERATION` | | `true` to generate campaign posters (default `false`) |
| `AUTO_DASHBOARD` | | Design a dashboard after each run (default `true`) |
| `DBT_MODELING` | | Run dbt before the analytics crew on PostgreSQL (default `true`) |
| `AIRFLOW_URL` | | Airflow API base (default `http://localhost:8085`) |
| `DATACHAT_MASK_PII` | | Pseudonymise personal-data columns in Data chat and the Agent (default on) |
| `PRICING_FILE` | | Path to the pricing file (default `pricing.json`) |
| `BILLING_ENFORCE` | | `false` records usage without blocking when the balance is short (default `true`) |
| `SLACK_BOT_TOKEN` · `NOTION_TOKEN` · `AIRTABLE_TOKEN` | | App connectors; otherwise paste a token per import |
| `GOOGLE_APPLICATION_CREDENTIALS` | | Service-account key for private Google Sheets / Drive files and BigQuery |
| `GOOGLE_OAUTH_CLIENT_ID` · `GOOGLE_OAUTH_CLIENT_SECRET` | | *Connect Google* for Sheets / Drive |
| `SLACK_CLIENT_ID` · `SLACK_CLIENT_SECRET` | | *Connect Slack* |
| `OAUTH_REDIRECT_BASE` · `OAUTH_ENCRYPTION_KEY` | | Callback base URL (default `http://localhost:8002`) · key for stored tokens (generated if unset) |
| `LANGCHAIN_API_KEY` | | LangSmith tracing |

---

## API reference

Interactive docs at **http://localhost:8002/docs**.

**Analytics pipeline**

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/analyze` | Start a run (charges 900 credits) |
| `POST` | `/api/upload` | Upload files |
| `GET` | `/api/stream/{task_id}` | Live log (SSE) |
| `GET` | `/api/status/{task_id}` · `/api/results/{task_id}` · `/api/logs/{task_id}` · `/api/tasks` | Status, results, logs, history |
| `POST` | `/api/approve/{task_id}` | Human review: approve or abort |
| `POST` / `GET` | `/api/chat/{task_id}` · `/api/chat/history/{task_id}` | Conversation |
| `GET` | `/api/graph/{task_id}` | Knowledge graph |

**Data chat**

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/datachat/sessions` | Start a chat (`files` and/or `import_ids` from app imports, or `db_uri` + `db_schema`) |
| `GET` | `/api/datachat/sessions` | List chats |
| `GET` · `DELETE` | `/api/datachat/sessions/{sid}` | Open or delete a chat |
| `POST` | `/api/datachat/sessions/{sid}/message` | Ask a question (charges 5 credits); the reply includes `followups` |
| `GET` | `/api/datachat/sessions/{sid}/overview` | Data profile + summary, issues and suggested questions (`?refresh=true` rebuilds) |
| `GET` · `PUT` | `/api/datachat/glossary` | Shared business definitions (`terms: [{term, definition}]`) |
| `GET` | `/api/kits` | Industry kits: company, highlights, metric definitions, suggested questions |
| `POST` | `/api/kits/{kit}/datachat` · `/analytics` · `/agent` · `/workflow` | Hand a kit (`fnb`, `retail`, `banking`, `marketing`) to an app; `/api/samples/*` is the `fnb` kit |
| `GET` | `/api/datachat/sessions/{sid}/tables/{ref}?format=xlsx\|csv` | Full result table behind an answer |
| `GET` | `/api/datachat/sessions/{sid}/charts/{name}.png` | A chart as PNG |
| `GET` · `POST` | `/api/datachat/pins` · `/api/datachat/sessions/{sid}/pins` | Pinboard · pin a chart or table (`turn`, `kind`, `index`) |
| `POST` · `DELETE` | `/api/datachat/pins/{id}/refresh` · `/api/datachat/pins/{id}` | Re-run a pin on current data · remove it |

**Agent**

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/agent/tasks` | Create a task (`goal`, optional `db_uri` + `db_schema`, `import_ids` from uploads or app imports); Claude drafts a plan |
| `GET` | `/api/agent/tasks` · `/api/agent/tasks/{id}` | List tasks · task with live events, checklist, researchers, files |
| `POST` | `/api/agent/tasks/{id}/approve` | Approve the (edited) plan and run (`steps`, `wide_items`) |
| `POST` | `/api/agent/tasks/{id}/cancel` | Stop a task |
| `DELETE` | `/api/agent/tasks/{id}` | Delete a task and its files |
| `GET` | `/api/agent/tasks/{id}/files/{path}` | Download a workspace file |

**Studio** (the same API under three prefixes: `/api/agent/tasks/{id}/studio`, `/api/runs/{run}/studio/{analytics or marketing}`, `/api/datachat/sessions/{sid}/studio`)

| Method | Endpoint | Description |
|---|---|---|
| `GET` · `PUT` | `…/{deck\|doc}` | Editable deck / document (built on first open; GET adds `assets` and `stale`); save with `base_version` |
| `POST` | `…/{kind}/ai` · `/restore` · `/rebuild` | AI edit (3 credits) · restore a version · start over from the source |
| `GET` | `…/{kind}/versions` · `/export?format=pptx\|docx\|pdf` | Version history · download |

**Workflow**

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/workflows/catalog` | Step types and their settings |
| `GET` · `POST` | `/api/workflows` | List · create a workflow |
| `POST` | `/api/workflows/generate` | Build (or edit, with `workflow_id`) a workflow from a `prompt` |
| `GET` · `PUT` · `DELETE` | `/api/workflows/{id}` | Open · save (name, nodes, edges, schedule) · delete |
| `POST` | `/api/workflows/{id}/files` · `/api/workflows/{id}/import` | Upload a data file · import a table from an app |
| `POST` | `/api/workflows/{id}/run` | Run now (paid steps charged as they run) |

**Billing**

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/billing` | Balance by bucket, plan, settings, pricing.json and recent activity |
| `GET` | `/api/billing/plans` | pricing.json |
| `POST` | `/api/billing/subscribe` | Switch plan (`plan_id`, `interval`) — demo checkout |
| `POST` | `/api/billing/topup` | Buy a top-up pack (`pack_id`) — demo checkout (`/purchase` is an alias) |
| `PUT` | `/api/billing/settings` | `spend_cap_usd` (null = no cap), `auto_topup` |
| `GET` | `/api/workflows/{id}/estimate` | Credits per run and per month on the saved schedule |

**Data, engineering and tools**

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/db/test` | Normalise + test a connection string; list schemas and tables |
| `GET` | `/api/connectors` | App connectors and whether the server holds a token for each |
| `POST` | `/api/connectors/import` | Import from Sheets, Drive, Slack, Notion, Airtable or a URL; returns a file like `/api/upload` |
| `GET` · `POST` · `DELETE` | `/api/dashboards…` | Design, list, view (with filters), delete dashboards |
| `GET` · `POST` | `/api/dbt/runs…` · `/api/dbt/build` · `/api/dbt/rebuild` | dbt build history, model SQL, AI-designed build, rebuild |
| `POST` · `GET` | `/api/airflow/setup` · `/api/airflow/status` · `/api/airflow/trigger` | Airflow setup, status, run now |
| `GET` · `POST` | `/api/models` · `/api/predict` | Trained models, scoring |
| `POST` | `/api/analyze/drivers` · `/api/analyze/whatif` · `/api/explore` | SHAP drivers, what-if, NL → read-only SQL |
| `POST` | `/api/rag/query` | Document Q&A |
| `GET` · `POST` · `DELETE` | `/api/monitors…` | Drift monitoring |

---

## Project structure

```
Universal_AI_Analytics/
├── main.py / app.py          FastAPI app: pipeline, SSE, persistence, all API routes
├── config.py                 Claude client + helpers, feature toggles (loads .env)
├── crew_banking.py           Analytics crew (5 agents, guardrails)
├── crew_marketing.py         Marketing crew (4 agents)
├── zep_graph.py              Zep knowledge graph builder
├── graphs/                   LangGraph planners (analytics, marketing)
├── features/
│   ├── agent.py              Agent: planning, tool loop, parallel researchers, deliverables
│   ├── studio.py             Studio: editable deck + document for Agent, Analytics and Data chat; AI edits, versions, pptx/docx/pdf
│   ├── workflow.py           Workflow: step catalog, graph executor, AI builder, schedules
│   ├── data_chat.py          Data chat sessions + LangChain agent, overview, glossary, exports, pinboard
│   ├── datachat_mcp.py       Read-only FastMCP server (describe_data · run_sql · run_python)
│   ├── billing.py            Credit wallet: plans, buckets, top-ups, refunds, ledger
│   ├── connectors.py         App connectors: Sheets, Drive, Slack, Notion, Airtable, file URL
│   ├── kits.py               Industry kits: fictional sample data, metric definitions, questions, workflows
│   ├── db_connect.py         Any-provider connection normaliser, test, shared pools
│   ├── dashboard.py          Automatic dashboard design + LLM-free data
│   ├── deeper.py             SHAP drivers, what-if, NL→SQL
│   └── scoring.py · monitor.py · rag.py
├── tools/
│   ├── llm_guard.py          PII masking, injection screening, untrusted-data fencing, answer sanitising
│   ├── py_kernel.py          Persistent sandboxed Python kernel (Data chat, Agent)
│   ├── insights.py           explain_change() + forecast() helpers preloaded in the Data chat kernel
│   ├── web_fetch.py          One-page headless browser fetch (Agent), run as a killable subprocess
│   ├── chart_codegen.py · chart_runner.py · chart_style.py · chart_pack.py
│   ├── dbt_builder.py · airflow_builder.py
│   ├── bank_engineer.py · bank_scientist.py · bank_analyst.py · bank_report.py
│   ├── work_ledger.py        Proof-of-work ledger for guardrails
│   └── mkt_*.py              Marketing tools
├── dbt/uaa/                  Generated dbt project
├── airflow/                  Docker Compose, Dockerfile, DAGs, dbt profile
├── frontend/
│   ├── app/page.tsx          App rail + layout
│   ├── components/views/     HomeView · Analytics views · DataChatView · AgentView · WorkflowView · PricingView · GuideView …
│   ├── components/studio/    Deck and document editors, present mode, OpenStudio buttons
│   ├── components/datachat/  Data overview, follow-ups, glossary panel
│   ├── components/AppConnectors.tsx   "From an app" picker used by every app
│   └── lib/                  API client, billing hook, types
├── data/                     Private: runs, chats, agent workspaces, wallet, audit log, dbt builds
└── outputs/                  Public (served at /outputs): charts, reports, agent deliverables
```

---

## Known limitations

- **No user accounts yet:** one shared wallet and one shared history. Run it locally or behind your own access control.
- **Demo checkout:** plan changes and top-ups don't take payment until a payment provider is connected.
- **One Analytics run at a time;** runs live in memory and are saved to JSON files (no multi-user job queue).
- dbt modelling and Airflow orchestration target **PostgreSQL** (including Supabase, Neon, RDS, Cloud SQL, Azure PostgreSQL).
- Data chat's first question in a new chat is slow (library loading + sandbox start), and so is the first data overview; both are much faster afterwards. Tables and charts from answers given before exports existed can't be downloaded.
- The Agent can't use sites that block automated browsers (e.g. Shopee, Blibli) and can't log in anywhere. Its arithmetic in the written answer isn't checked against the numbers it computed.
- App imports into Analytics, Data chat and the Agent are snapshots (import again to refresh); only Workflow's *App data* step fetches fresh data on every run. Connectors use pasted links and tokens or a Google service account — there is no OAuth sign-in.
- Studio decks use the Ouroboros style only (no custom themes); text formatting is bold and italic; images are limited to the platform's own charts. Building a deck for a large report takes up to a minute or two the first time.
- The Analytics *Conversation* tab still runs chart code in-process with keyword filters; Data chat and the Agent use the full sandbox.
- Altair and Bokeh charts are HTML-only, so they don't appear in PDF or PowerPoint exports.

---

## Architecture poster brief

> Paste this section into an image or diagram tool to generate an architecture poster.

**Title:** Ouroboros
**Tagline:** From raw data to a decision, and the campaign that acts on it.

**Layers (top to bottom):**

1. **Interface** — Next.js 14 web app with an app rail: Home · Analytics · Data chat · Agent · Workflow · Pricing · Docs; Studio editors for decks and documents.
2. **API** — FastAPI backend on port 8002: REST, Server-Sent Events, persistence, credit billing.
3. **Data connection** — any-provider normaliser for PostgreSQL (Supabase, Neon, RDS, Cloud SQL, Azure), MySQL, SQL Server, Oracle, Redshift, BigQuery, Snowflake, DuckDB/SQLite, plus file uploads and app connectors (Google Sheets, Drive, Slack, Notion, Airtable, URL); shared pools.
4. **Data engineering** — dbt (Claude-designed staging → marts with tests) and Airflow in Docker (daily build + quality gate).
5. **Planning** — LangGraph planners (analytics, marketing) with a human approval gate; Agent plan review.
6. **Agents on Claude Haiku 5.5** — Analytics crew (5) → Marketing crew (4); Data chat agent; autonomous Agent with up to 8 parallel researchers.
7. **Safe tool layer** — read-only FastMCP server, sqlglot SQL validation, sandboxed Python kernel, LLM guard (PII masking, injection screening, output sanitising), SSRF-guarded headless browser.
8. **Outputs** — Power BI-style dashboard, AI-written charts, editable decks and documents (Studio) exported to PowerPoint / Word / PDF, Excel, knowledge graph, RAG answers, drift alerts, Slack / Teams / webhook alerts.
9. **External services** — Anthropic Claude, Tavily, Exa, Zep, LangSmith, optional Gemini (posters).

**Main flows:**
- Analytics: brief → connect → plan → human review → dbt → analytics crew → dashboard → marketing crew → reports.
- Data chat: question → MCP tools (SQL / Python in sandbox) → answer with code.
- Agent: goal → plan → approve → search / browse / analyse ⇄ parallel researchers → answer with conclusion + recommendations → deliverables.
- Workflow: sources (incl. live app data) → transforms → quality check / condition → ML / AI → report, export or alert, on a schedule.
- Studio: any report → editable deck + document → AI edits → present / export.

**Suggested colours:** interface ink/charcoal with a vermilion accent · data & engineering teal · AI planning & agents violet · outputs Power BI blue `#118DFF` · external services grey.

**Key numbers:** 7 apps · 9 crew agents + Data chat agent + Agent with 8 parallel researchers · 11+ database engines · 6 app connectors · 32 workflow steps · 21–42 dbt tests per build · ~4k tokens per dashboard, 0 to filter it · ~97% prompt-cache hit rate in Agent tasks.

---

## Acknowledgements

[Anthropic Claude](https://www.anthropic.com/) · [CrewAI](https://github.com/crewAIInc/crewAI) · [LangGraph](https://github.com/langchain-ai/langgraph) · [FastMCP](https://github.com/jlowin/fastmcp) · [dbt](https://www.getdbt.com/) · [Apache Airflow](https://airflow.apache.org/) · [Playwright](https://playwright.dev/) · [Next.js](https://nextjs.org/) · [FastAPI](https://fastapi.tiangolo.com/) · [Plotly](https://plotly.com/python/) · [SHAP](https://github.com/shap/shap) · [sqlglot](https://github.com/tobymao/sqlglot) · [FAISS](https://github.com/facebookresearch/faiss) · [Zep](https://www.getzep.com/) · [Exa](https://exa.ai/) · [Tavily](https://tavily.com/) · [LangSmith](https://smith.langchain.com/)
