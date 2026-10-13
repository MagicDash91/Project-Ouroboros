"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { cx } from "@/components/ui";

/** Product documentation: how to run, use and secure both apps on this desk. */

type Page = { key: string; group: string; title: string; summary: string; body: string };

const PAGES: Page[] = [
  {
    key: "overview",
    group: "Start here",
    title: "Overview",
    summary: "What the desk does and which app to use",
    body: `
Ouroboros is several apps on one desk. Switch between them with the rail on the far left.

| App | Use it when | What you get |
|---|---|---|
| **Analytics** | You want a full, end-to-end analysis of a dataset | A strategic plan you approve, dbt models, forecasts / segments / classifiers, AI-written charts, a Power BI-style dashboard, PDF + PowerPoint reports, and a marketing campaign |
| **Data chat** | You have a quick question about a file or database | A short answer with the SQL / Python behind it, tables and charts |

**New here?** On the Home page, **Start here** lets you pick your industry (food & beverage, retail, banking or marketing) and try every app on a fictional sample company: no data needed.

### How it is built

- **Frontend**: Next.js 14 + Tailwind on port **3010**
- **Backend**: FastAPI + Uvicorn on port **8002** (REST + Server-Sent Events)
- **Model**: Claude Haiku 5.5 (\`ANTHROPIC_MODEL\`)
- **Agents**: LangGraph planner → CrewAI analytics and marketing crews; LangChain agent + FastMCP tools for Data chat
- **Data engineering**: dbt models and tests, optionally scheduled with Airflow (Docker)
`,
  },
  {
    key: "run",
    group: "Start here",
    title: "Running locally",
    summary: "Start the backend and the frontend",
    body: `
Open two terminals.

**1. Backend** (port 8002)

\`\`\`powershell
cd D:\\Langsmith-main
.\\venv\\Scripts\\Activate.ps1
cd Universal_AI_Analytics
python main.py
\`\`\`

**2. Frontend** (port 3010)

\`\`\`powershell
cd D:\\Langsmith-main\\Universal_AI_Analytics\\frontend
npm run dev
\`\`\`

Open **http://localhost:3010**. The frontend calls the backend at \`http://localhost:8002\` (override with \`NEXT_PUBLIC_BACKEND_URL\`).

**3. Airflow** (optional, needs Docker Desktop): generate the setup from *Data models*, then

\`\`\`powershell
cd airflow
docker compose up -d --build   # UI at http://localhost:8085
\`\`\`

### Configuration (\`.env\`)

| Variable | Required | Purpose |
|---|---|---|
| \`ANTHROPIC_API_KEY\` | yes | Claude API key |
| \`ANTHROPIC_MODEL\` | no | Defaults to \`claude-haiku-5-5\` |
| \`POSTGRES_HOST\` / \`PORT\` / \`DB\` / \`USER\` / \`PASSWORD\` | no | Default database when no connection string is given |
| \`TAVILY_API_KEY\` | no | Web research for marketing |
| \`EXA_API_KEY\` · \`ZEP_API_KEY\` | no | Knowledge graph enrichment and storage |
| \`AUTO_DASHBOARD\` | no | Design a dashboard after each run (default \`true\`) |
| \`DBT_MODELING\` | no | Run dbt before the analytics crew on PostgreSQL (default \`true\`) |
| \`AIRFLOW_URL\` | no | Airflow API base (default \`http://localhost:8085\`) |
| \`SLACK_BOT_TOKEN\` · \`NOTION_TOKEN\` · \`AIRTABLE_TOKEN\` | no | App connectors; without them, paste a token when importing |
| \`GOOGLE_APPLICATION_CREDENTIALS\` | no | Service-account key for private Google Sheets and Drive files (also BigQuery) |
`,
  },
  {
    key: "analytics",
    group: "Analytics",
    title: "Running an analysis",
    summary: "Brief, review, and the agent pipeline",
    body: `
1. **Write the brief.** In the left panel describe the business question, then pick a data source: upload files, paste a database connection string, or import from an app (*From an app*: Google Sheets, Drive, Slack, Notion, Airtable or a file URL).
2. **Start the run.** The *Wire* tab streams the live log.
3. **Review the plan.** LangGraph drafts an analytics plan; a review sheet opens and nothing expensive happens until you approve it.
4. **Data engineering.** On PostgreSQL, dbt builds staging and mart models and runs tests.
5. **Analytics crew.** The data scientist picks the method the data supports (time-series forecast, classifier or segmentation); the analyst writes charts and the insight report.
6. **Dashboard and marketing.** A Power BI-style dashboard is designed automatically, then the marketing crew writes the strategy, ad copy and social posts.

### The agents

| Agent | Job |
|---|---|
| Data Engineer | Profiles the source, builds dbt models and tests |
| Senior Data Scientist | Forecasts, segments, classifiers, SHAP drivers |
| Senior Data Analyst | Problem-driven charts, insight report, PDF and PowerPoint |
| CDO | Reviews and signs off the analytics output |
| Researcher · Planner · Content Creator · CMO | Market research, campaign strategy, ad copy and posts |
`,
  },
  {
    key: "sections",
    group: "Analytics",
    title: "Result tabs",
    summary: "What each tab in the Analytics app shows",
    body: `
| Group | Tab | Shows |
|---|---|---|
| Run | **Wire** | Live log of the run |
| | **Dashboard** | Auto-designed Power BI-style dashboard with filters |
| | **Analytics** | The insight report |
| | **Charts** | AI-written interactive charts (Plotly, Altair, Bokeh, Matplotlib) |
| | **Marketing** · **Content** | Campaign brief, ad copy, social posts |
| | **Files** | PDF, PowerPoint and Markdown downloads |
| Ask | **Conversation** | Follow-up questions about the finished run |
| | **Graph** | Knowledge graph of entities found in the run |
| Tools | **Data models** | dbt lineage, model SQL, test results, Airflow |
| | **Model lab** | Score new data, SHAP drivers, what-if |
| | **Monitoring** | Data drift monitors |
| | **Documents** | Question answering over uploaded documents (RAG) |

Finished runs, chat history, dashboards and dbt builds are saved and survive backend restarts. A dot next to a tab means it has new results.
`,
  },
  {
    key: "datachat",
    group: "Data chat",
    title: "Using Data chat",
    summary: "Connect a file or database and ask questions",
    body: `
1. Click **+ New data chat**.
2. Either upload files (CSV · TSV · XLSX · XLS · Parquet · Feather · JSON · JSONL, up to 200 MB each) paste a database connection string and optional schema, or use **Connect an app** to import tables from Google Sheets, Drive, Slack, Notion, Airtable or a file URL.
3. Ask a question in plain language, or click one of the **suggested questions** in the *Data overview* (a profile of your tables with data-quality notes). Every answer shows the SQL or Python it ran: expand a step to see the code and its output.
4. Click a **follow-up** under the latest answer to keep exploring.
5. Download any table as **Excel / CSV** (the full result, not just the preview) or a chart as **PNG**, and **Pin** results to the **Pinboard**, where *Refresh* re-runs them on the current data for free.
6. **Turn this chat into** a deck, Word document or PDF: the editors start with every question, answer, table and chart, and offer *Update from chat* when you have asked more.

The **Glossary** in the side panel holds your business definitions (e.g. *active customer = ordered in the last 90 days*); every answer applies them.

### Why did it change? Forecasts and what-if

- Ask **"why did revenue drop in September?"** and the answer splits the change across every category (branch, product, channel…), names the groups that moved differently from the overall trend, looks one level inside the biggest one and draws a waterfall chart. Compare months, quarters, years, any two date ranges, or the same period last year.
- Ask **"forecast sales for the next 3 months"** for a forecast with a likely range (80% of outcomes) and how accurate the model was on recent months it had not seen.
- Ask **"what if we raise prices 5%?"**: the answer states the assumption it used (for example, how much volume drops), shows the arithmetic and draws the scenario next to the forecast.
- These numbers are calculated in Python, not by the AI. Explanations work on totals (revenue, orders, NPL balance); for a ratio such as conversion rate or NPL ratio they explain the top and the bottom of the fraction.

**Industry kits:** on the Home page, *Start here* opens a sample company for food & beverage, retail, banking or marketing, with metric definitions and six questions ready to click.

The agent has three tools, all read-only:

| Tool | What it does |
|---|---|
| \`describe_data\` | Lists datasets, columns, types and which columns are masked |
| \`run_sql\` | One validated \`SELECT\` against the database; the result becomes a DataFrame |
| \`run_python\` | pandas / Plotly code in the session's sandbox; variables persist between questions |

### Example questions

- What are the top 10 products by revenue (quantity × unit price)? Show a bar chart.
- How many orders are there per sales channel?
- Show monthly revenue for the last 12 months as a line chart.
- Which customer segment has the highest average order value?
- Compare discount percentage against order value. Is there a relationship?
- Why did revenue change in March compared with February?
- Forecast monthly revenue for the next quarter. What if we raise prices 5% and lose 4% of orders?

### How long answers take

The **first question** in a new chat is the slowest: the backend loads its libraries and starts the session's Python sandbox. **Follow-up questions** in the same chat are much faster, typically 15–30 seconds, which is mostly the model working through its 2–4 steps. Up to 3 sandboxes run at once; switching between many chats restarts older ones.
`,
  },
  {
    key: "databases",
    group: "Data chat",
    title: "Connecting a database",
    summary: "Connection strings, Supabase pooler, troubleshooting",
    body: `
Paste a standard SQLAlchemy-style URI. PostgreSQL, MySQL, SQL Server, Oracle, Redshift, Snowflake, BigQuery, DuckDB and SQLite are recognised; the connection is tested before the chat starts.

\`\`\`text
postgresql://USER:PASSWORD@HOST:5432/DATABASE
\`\`\`

### Supabase

Supabase's direct host (\`db.<project>.supabase.co\`) is **IPv6-only** and won't resolve on most IPv4 networks. Use the **Session pooler** URI from *Supabase → Connect → Session pooler*:

\`\`\`text
postgresql://postgres.<project-ref>:PASSWORD@aws-0-<region>.pooler.supabase.com:5432/postgres
\`\`\`

Note the two differences: the host is the regional pooler, and the user is \`postgres.<project-ref>\`, not \`postgres\`.

### Troubleshooting

| Message | Fix |
|---|---|
| *Can't reach the server* | Wrong host, or an IPv6-only host; use the pooler URI above |
| *Tenant or user not found* | Wrong pooler region or missing \`.<project-ref>\` in the user |
| *Password authentication failed* | Reset the database password in your provider and update the URI |
| Connects to the wrong database on 5432 | A native PostgreSQL may already be listening locally; map Docker databases to another host port |
`,
  },
  {
    key: "connectors",
    group: "Data chat",
    title: "Connecting apps",
    summary: "Google Sheets, Drive, Slack, Notion, Airtable, file URLs",
    body: `
Every app can pull data straight from the tools your team uses: the Analytics brief (*From an app*), Data chat (*Connect an app*), the Agent (*Bring in data from an app*, placed in the task workspace under \`inputs/\`) and Workflow (*Import from an app*, in the side panel or an Upload step). Each import becomes a table, stored like an uploaded file. Documents from Drive (PDF, Word, PowerPoint) become context for Analytics runs and Agent tasks; Data chat and Workflow need tables.

| App | What you paste | What you get | Access |
|---|---|---|---|
| **Google Sheets** | The sheet link | The tab in the link, as a table | Link-shared sheets work as they are; private ones need a service account |
| **Google Drive** | A file link | CSV, Excel, JSON, Parquet files as tables; Docs, Slides, PDF, Word as documents | Same as Sheets |
| **Slack** | \`#channel\` or a channel link | One row per message: time, author, text, replies, reactions | Bot token (\`xoxb-…\`) |
| **Notion** | A database link | One row per page, one column per property | Integration secret |
| **Airtable** | A table link (with a view, if you want it filtered) | One row per record | Personal access token |
| **File URL** | A direct link to a file | The file | None; only public addresses |

Tokens can be pasted in the form (used for that import only, never stored) or set once on the server: \`SLACK_BOT_TOKEN\`, \`NOTION_TOKEN\`, \`AIRTABLE_TOKEN\`. A dot next to an app means the server already has its token.

### Setting up access

- **Google (private files):** create a service account in Google Cloud, enable the Drive API, download its JSON key and set \`GOOGLE_APPLICATION_CREDENTIALS\` to its path. Then share each sheet or file with the service account's email (Viewer is enough).
- **Slack:** create an app at api.slack.com, add the bot scopes \`channels:history\`, \`channels:read\`, \`groups:history\`, \`groups:read\` and \`users:read\`, install it, and copy the *Bot User OAuth Token*. Invite the bot to each channel with \`/invite @your-bot\`.
- **Notion:** create an internal integration at notion.so/my-integrations, copy its secret, then open the database → ••• → *Connections* → add the integration.
- **Airtable:** create a personal access token at airtable.com/create/tokens with \`data.records:read\` and access to the base.

Imports are capped at 100 MB per file and 200,000 rows per app table. Imports are a snapshot: import again to refresh.
`,
  },
  {
    key: "security",
    group: "Data chat",
    title: "Security & privacy",
    summary: "Read-only access, PII masking, prompt-injection defence",
    body: `
Data chat is designed so that the model **cannot change your data** and **never sees raw personal data**.

### Read-only by construction

- The agent's only tools come from a read-only **FastMCP** server; it has no other way to reach the database or the machine.
- Every SQL statement is parsed (sqlglot) and rejected unless it is a single \`SELECT\`: no writes, DDL, \`SELECT INTO\`, row locks, multiple statements, dangerous functions (\`pg_sleep\`, \`dblink\`, \`pg_read_file\`…) or credential/system tables (Supabase \`auth\`/\`vault\`, \`pg_authid\`…).
- Accepted queries run inside a \`READ ONLY\` transaction with a 30-second statement timeout and a 200,000-row cap.
- Python runs in a separate sandboxed process with no file, network or OS access and a 90-second limit per cell.

### Personal data (PII)

- Columns that hold names, emails, phone numbers, IDs or addresses are **pseudonymised** before the model sees them. Aliases are traced, so \`SELECT email AS x\` stays masked.
- Free text in results and in your own messages is redacted.
- You can still count, group and compare people by their masked IDs, but the assistant will refuse to reveal or reconstruct real values.

### Prompt injection and leaks

- Messages are screened for injection, credential requests and re-identification attempts before they reach the model.
- Tool output is fenced as untrusted data; instructions planted inside your data are flagged and ignored.
- Answers are checked for system-prompt leaks (canary token) and stripped of external links and images that could exfiltrate data.

### Audit and limits

- Every turn is logged to \`data/audit/datachat_audit.jsonl\`: flags, tools used, timing and a message hash, never the message content.
- Each chat is limited to 20 questions per 5 minutes.
`,
  },
  {
    key: "agent",
    group: "Agent",
    title: "Using the Agent",
    summary: "Autonomous tasks, parallel research, deliverables",
    body: `
The Agent is an autonomous worker in the style of Manus: you give it a goal, it plans, then it works on its own and hands back an answer and finished files.

1. **Describe the goal** in a sentence or two. Optionally connect a database (read-only).
2. **Review the plan.** Planning is free. Edit, add or remove steps, and the list of items for parallel research. The exact cost is shown before you approve.
3. **Watch it work.** The activity log shows every search, page, calculation and file; the side panel shows its checklist, parallel researchers, workspace files and sources. You can stop it at any time (stopped tasks are refunded).
4. **Get the result**: an answer with linked sources, plus any deliverables (PDF report, PowerPoint deck, Markdown, Excel).

### What it can do

| Tool | What it does |
|---|---|
| Search · Browse | Tavily web search; a real headless browser reads pages (each page in its own process with a 45 s limit) |
| Workspace files | Full page text and findings are saved as files, so long tasks don't lose information |
| Python | Calculations and charts in the same sandbox as Data chat |
| Database | Read-only SQL with personal data masked (only if you connect one) |
| Parallel research | Up to 8 researcher agents work at once, one per item (company, product, city…) |
| Deliverables | PDF report + slide deck + Markdown, or an Excel workbook |

### Good tasks

- Competitor price checks across online stores
- Market or competitor research for several companies at once
- Combining web research with your own sales data ("compare our prices with competitors'")

### Guardrails

- It **cannot send, post, buy, sign up or delete** anything, fill in forms or log in.
- Web pages and search results are treated as **data, never instructions**; planted instructions are flagged.
- It can't open private or internal network addresses (localhost, 192.168.x.x, cloud metadata).
- The final answer can only link to pages it actually visited.
- Some sites (e.g. Shopee, Blibli) block automated browsers; the agent notices and uses other sources.

### Editing the result: deck and document

When a task produced a report, the side panel shows **Edit & present deck** and **Edit document**. Both open full-screen editors built from the agent's report (the deck is laid out by Claude the first time, the document keeps the report's wording). The same editors are on an Analytics run's *Analytics report* page (with the run's own chart images as image slides and a *Key charts* section) and *Campaign brief* page.

| | Deck | Document |
|---|---|---|
| Edit by hand | Click any text; Enter adds a bullet; Ctrl+B / Ctrl+I bold and italic; reorder, duplicate, delete and add slides; 8 layouts (title, section, bullets, two columns, chart, table, big number, quote); chart data grid; speaker notes | Click any text; add, convert, move and delete blocks (text, heading, bullets, numbered, table, chart, quote); edit table cells and chart data |
| Ask AI | *This slide* or *Everything*: "make it shorter", "turn this into a chart", "split into two slides", "translate to Bahasa Indonesia" | *This block* or *Everything*: "rewrite for executives", "turn this table into a chart" |
| Show / export | **Present** full screen (← → to move, N for notes, Esc to exit); **Export .pptx** with native, editable charts and tables plus speaker notes | **Export Word** (.docx) and **PDF** |

Changes save automatically. **History** keeps the last 30 versions (quick edits are grouped; every AI edit is its own version): restore any of them, or start over from the agent's report. Manual editing, presenting and exporting are free; each AI edit costs 3 credits and is refunded if it fails. AI edits use only numbers already in the content and never invent new ones.
`,
  },
  {
    key: "workflow",
    group: "Workflow",
    title: "Building workflows",
    summary: "Automations on a canvas, by hand or by prompt",
    body: `
A workflow is a chain of steps that runs your analysis for you: load data, transform it, model it, let AI write about it, and produce charts, reports and files. Build it by hand on the canvas, or **describe what you want and AI builds it**.

1. **+ New workflow**, then either type in the ✦ AI bar ("Load my sales file, calculate revenue, chart it by region and write a report") or drag steps from the palette.
2. **Connect** steps by dragging from a step's right dot to the next step's left dot. Loops are blocked.
3. **Configure** a step by clicking it: the right panel shows its settings. Column fields list the columns available from the step before it.
4. **▶ Run**. The button shows what one run costs: only Web search (10 credits), AI insights (2), Report with AI text (5) and Agent task steps are paid; everything else is free. Each step shows its status, rows and time; click a step and open **Output** to see its table, chart, text, metrics and files.
5. **Change it with AI**: once a workflow exists, the AI bar edits it ("also export to Excel", "add a forecast").
6. **⏱ Schedule** it to run every hour, day or week. AI can prepare a schedule, but only you switch it on.

### Steps

| Group | Steps |
|---|---|
| Sources | File (CSV, Excel, Parquet, JSON) · Database query (one read-only SELECT) · Web search · App data (Google Sheets, Drive, Slack, Notion, Airtable, file URL; fresh on every run) |
| Transform | Filter rows · Keep / drop columns · Rename columns · Clean data · Formula column · Group & summarise · Sort & limit · Join (two inputs) · Append tables · Pivot · Unpivot · Date tools · Calculate (running total, % change, moving average, rank, share of total) · Bucket values |
| Quality & logic | Data quality check (rules such as \`not_null: customer_id\`, \`between: amount, 0, 1000000\`; stop or continue) · Condition (continue only if, e.g., the sum of sales is below a target) |
| Machine learning | Forecast (Holt-Winters + backtest error) · Predict (classifier or regressor, key drivers) · Segment (K-Means) · Anomaly detection |
| AI | AI insights · AI classify (sentiment / your categories / extract a field per row) · Agent task (runs the autonomous Agent; adds Agent pricing) |
| Outputs | Chart (interactive) · Report (PDF + deck + Markdown) · Export file (Excel / CSV) · Send alert (Slack, Teams or webhook) |

Example: *every morning → App data (Google Sheet) → Data quality check → Calculate % change → Condition → Send alert to Slack.* A Condition that isn't met skips the steps after it without marking the run as failed.

### Good to know

- A failed step skips everything after it; the rest of the workflow still runs. Paid steps are charged as they run, a paid step that fails is refunded, and skipped steps are never charged.
- The ⏱ Schedule panel shows the estimated credits per month for the chosen schedule before you switch it on.
- AI steps see a summary of the data with personal-data columns masked.
- Database steps are read-only, and connection passwords are never shown again after saving.
- Schedules run while the backend is running.
`,
  },
  {
    key: "pricing",
    group: "Reference",
    title: "Pricing & credits",
    summary: "Plans, credits, top-ups and what each action costs",
    body: `
Everything is paid for with **credits** (1 credit = $0.01 / Rp 159 at top-up price; plan credits cost less). Your balance, plan and the live rate card are on the *Pricing* page in the left rail. All prices come from one file, \`pricing.json\`, which the backend and this UI both read.

### Plans

| Plan | Price | Credits |
|---|---|---|
| Free | $0 | 1,000 at signup + 150 / month |
| Starter | $12 / month | 1,500 / month |
| Pro | $29 / month | 6,000 / month |
| Team | $149 / month | 35,000 / month, shared, 5 seats |
| Enterprise | By contract | Contracted |

Annual billing: pay for 10 months, get 12. IDR prices are set separately (not converted live).

### What things cost

| Action | Credits |
|---|---|
| Analytics run (plan → dbt → crew → dashboard → report → campaign) | 900 |
| Data chat question | 5 |
| Agent task (includes 8 web searches) | 100, then 10 per extra search |
| Parallel researcher (up to 4 searches each) | 40 |
| Workflow step: Web search · AI insights · Report with AI text | 10 · 2 · 5 per run |
| Extra dashboard page | 5 |
| Model lab call (scoring, drivers, what-if, NL→SQL) | 2 |
| Document Q&A question | 3 |

**Free:** planning (Analytics and Agent), dashboard filtering and refreshing, building and editing workflows with AI, and deterministic workflow steps.

### Top-ups

| Pack | Credits | Price |
|---|---|---|
| Small | 1,000 | $10 |
| Medium | 5,000 | $45 |
| Large | 20,000 | $160 |

### How credits are spent

- **Spend order:** rollover → plan → free monthly → signup → top-up, soonest-expiring first.
- **Rollover:** up to 50% of a paid plan's monthly credits carry into the next month. Top-up credits never expire.
- **Refunds** are automatic: an aborted or failed Analytics run, a Data chat question blocked by security screening or that errors, a stopped or failed Agent task, a failed workflow step, and any metered call that returns an error. Refunds go back to the bucket the credits came from (or become top-up credits if it has expired).
- **Low balance:** the request is refused (HTTP 402) and nothing is charged, unless **auto top-up** is on; then the smallest pack is bought so the balance stays above 200 credits.
- **Spend cap:** top-ups in one period (manual and automatic) stop at your cap. It defaults to 2× the plan price ($20 on Free) and can be changed or removed under *Spending controls*.
- Set \`BILLING_ENFORCE=false\` to record usage without blocking.

**Checkout is in demo mode**: choosing a plan or buying a pack adds credits without taking payment. Real checkout (Stripe for USD, Xendit or Midtrans for IDR) must grant credits only from a verified payment webhook. The wallet and its history are stored in \`data/billing/wallet.json\`; an old token wallet is archived to \`wallet_tokens_archive.json\` on first load.
`,
  },
  {
    key: "api",
    group: "Reference",
    title: "API reference",
    summary: "Backend endpoints on port 8002",
    body: `
Interactive docs: **http://localhost:8002/docs**

### Pipeline

| Method | Endpoint | Description |
|---|---|---|
| POST | \`/api/analyze\` | Start a run |
| POST | \`/api/upload\` | Upload files |
| GET | \`/api/stream/{task_id}\` | Live log (SSE) |
| GET | \`/api/status/{task_id}\` · \`/api/results/{task_id}\` · \`/api/tasks\` | Status, results, history |
| POST | \`/api/approve/{task_id}\` | Approve or abort the plan |
| POST | \`/api/chat/{task_id}\` | Conversation about a run |
| GET | \`/api/graph/{task_id}\` | Knowledge graph |

### Data chat

| Method | Endpoint | Description |
|---|---|---|
| POST | \`/api/datachat/sessions\` | Start a chat (\`files\` or \`db_uri\` + \`db_schema\`) |
| GET | \`/api/datachat/sessions\` | List chats |
| GET · DELETE | \`/api/datachat/sessions/{sid}\` | Open or delete a chat |
| POST | \`/api/datachat/sessions/{sid}/message\` | Ask a question |

### Data and tools

| Method | Endpoint | Description |
|---|---|---|
| POST | \`/api/db/test\` | Test a connection string; list schemas and tables |
| GET | \`/api/connectors\` | App connectors and whether the server has a token for each |
| POST | \`/api/connectors/import\` | Import from an app (\`{connector, params}\`); returns a file like \`/api/upload\` |
| POST | \`/api/workflows/{id}/import\` | Import a table from an app into a workflow's files |
| GET · POST · DELETE | \`/api/dashboards…\` | Dashboards |
| GET · POST | \`/api/dbt/runs…\` · \`/api/dbt/build\` | dbt builds and models |
| POST | \`/api/airflow/setup\` · \`/api/airflow/trigger\` | Airflow |
| POST | \`/api/predict\` · \`/api/analyze/drivers\` · \`/api/analyze/whatif\` | Model lab |
| POST | \`/api/rag/query\` | Document Q&A |

### Agent

| Method | Endpoint | Description |
|---|---|---|
| POST | \`/api/agent/tasks\` | Create a task (\`goal\`, optional \`db_uri\` + \`db_schema\`); Claude drafts a plan |
| GET | \`/api/agent/tasks\` · \`/api/agent/tasks/{id}\` | List tasks · task with live events, checklist, researchers, files |
| POST | \`/api/agent/tasks/{id}/approve\` | Approve the (edited) plan and run (\`steps\`, \`wide_items\`) |
| POST | \`/api/agent/tasks/{id}/cancel\` · DELETE \`/api/agent/tasks/{id}\` | Stop · delete |
| GET | \`/api/agent/tasks/{id}/files/{path}\` | Download a workspace file |
| GET · PUT | \`/api/agent/tasks/{id}/studio/{kind}\` · \`/api/runs/{run}/studio/{analytics or marketing}/{kind}\` | Editable deck or doc (kind = deck · doc; built from the report on first open); save with \`base_version\` |
| POST | \`…/studio/{kind}/ai\` · \`/restore\` · \`/rebuild\` | AI edit (\`instruction\`, optional \`target_id\`) · restore a version · start over |
| GET | \`…/studio/{kind}/versions\` · \`/export?format=pptx · docx · pdf\` | Version history · download |

### Billing

| Method | Endpoint | Description |
|---|---|---|
| GET | \`/api/billing\` | Balance by bucket, plan, settings, pricing.json and recent activity |
| GET | \`/api/billing/plans\` | pricing.json (plans, packs, action costs) |
| POST | \`/api/billing/subscribe\` | Switch plan (\`plan_id\`, \`interval\` month/year); demo checkout |
| POST | \`/api/billing/topup\` | Buy a top-up pack (\`pack_id\`); demo checkout |
| PUT | \`/api/billing/settings\` | \`spend_cap_usd\` (null = no cap) and \`auto_topup\` |
| GET | \`/api/workflows/{id}/estimate\` | Credits per run and per month on the saved schedule |
`,
  },
  {
    key: "limits",
    group: "Reference",
    title: "Known limitations",
    summary: "What isn't supported yet",
    body: `
- dbt modelling and Airflow orchestration target **PostgreSQL** (including Supabase, Neon, RDS, Cloud SQL, Azure PostgreSQL).
- One analytics run at a time; runs are kept in memory and saved to JSON files.
- **No user authentication**: run it locally or behind your own access control.
- The Analytics *Conversation* tab still runs chart code in-process with keyword filters; Data chat uses the full sandbox.
- Altair and Bokeh charts are HTML-only, so they don't appear in PDF or PowerPoint exports.
`,
  },
];

const GROUPS = Array.from(new Set(PAGES.map((p) => p.group)));

export function GuideView() {
  const [current, setCurrent] = useState(PAGES[0].key);
  const [query, setQuery] = useState("");
  const mainRef = useRef<HTMLElement>(null);

  // Each page opens at its top.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [current]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? PAGES.filter((p) => `${p.title} ${p.summary} ${p.body}`.toLowerCase().includes(q)) : PAGES;
  }, [query]);

  const index = PAGES.findIndex((p) => p.key === current);
  const page = PAGES[index];
  const prev = PAGES[index - 1];
  const next = PAGES[index + 1];

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <aside className="shrink-0 border-b border-rule bg-sheet/60 px-5 py-6 lg:w-[270px] lg:overflow-y-auto lg:border-b-0 lg:border-r">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the docs…"
          aria-label="Search the docs"
          className="w-full border-b border-rule bg-transparent py-1.5 text-[13px] text-ink placeholder:text-mute focus:border-ink focus:outline-none"
        />

        {GROUPS.map((g) => {
          const items = matches.filter((p) => p.group === g);
          if (!items.length) return null;
          return (
            <div key={g}>
              <div className="label mb-2 mt-6">{g}</div>
              <ul className="space-y-0.5">
                {items.map((p) => (
                  <li key={p.key}>
                    <button
                      onClick={() => setCurrent(p.key)}
                      aria-current={current === p.key ? "page" : undefined}
                      className={cx(
                        "w-full border-l-2 py-1.5 pl-2 text-left text-[13px] transition-colors",
                        current === p.key ? "border-signal text-ink" : "border-transparent text-graphite hover:text-ink",
                      )}
                    >
                      {p.title}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {!matches.length && <p className="mt-6 text-[12px] italic text-mute">Nothing matches “{query}”.</p>}
      </aside>

      <main ref={mainRef} className="min-w-0 flex-1 lg:overflow-y-auto">
        <article className="mx-auto max-w-[820px] px-6 py-10 lg:px-10">
          <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-signal">{page.group}</div>
          <h1 className="mt-2 font-serif text-[34px] leading-tight text-ink">{page.title}</h1>
          <p className="mt-1 text-[13px] text-mute">{page.summary}</p>
          <div className="mb-8 mt-5 border-b border-ink" />

          <Markdown>{page.body.trim()}</Markdown>

          <nav className="mt-14 flex justify-between gap-4 border-t border-rule pt-5 text-[13px]" aria-label="Pages">
            {prev ? (
              <button onClick={() => setCurrent(prev.key)} className="text-left text-graphite hover:text-ink">
                <span className="block font-mono text-[10.5px] uppercase tracking-[0.1em] text-mute">Previous</span>
                {prev.title}
              </button>
            ) : (
              <span />
            )}
            {next && (
              <button onClick={() => setCurrent(next.key)} className="text-right text-graphite hover:text-ink">
                <span className="block font-mono text-[10.5px] uppercase tracking-[0.1em] text-mute">Next</span>
                {next.title}
              </button>
            )}
          </nav>
        </article>
      </main>
    </div>
  );
}
