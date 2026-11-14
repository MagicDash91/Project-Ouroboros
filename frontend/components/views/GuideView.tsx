"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { cx } from "@/components/ui";

/** Product documentation: how to run, use and secure every app on this desk. */

type Page = { key: string; group: string; title: string; summary: string; body: string };

const PAGES: Page[] = [
  {
    key: "overview",
    group: "Getting started",
    title: "Overview",
    summary: "What the desk does and which app to use",
    body: `
Ouroboros is one desk with several apps that share the same data, credits and security. Switch between them with the rail on the far left.

| App | Use it when | What you get |
|---|---|---|
| **Analytics** | You want a full, end-to-end analysis of a dataset | A plan you approve, dbt models and tests, forecasts / segments / classifiers, AI-written charts, an automatic dashboard, PDF + PowerPoint reports and a marketing campaign |
| **Boards** | You want a dashboard from files or a database | KPIs, charts and filters designed for you, a chat that answers questions or edits the board, exports to PowerPoint and Excel |
| **Metrics** | You want one definition of "revenue" everywhere, or to check a file's quality | Business metric definitions used by every app, and a data-quality check with one-click fixes |
| **Data chat** | You have a quick question about a file, database or app | Short answers with the SQL / Python behind them, tables, charts, follow-ups and a pinboard |
| **Agent** | The task needs the web, documents or several sources | A plan you approve, then autonomous research and analysis, an answer with sources, and an editable report, deck or spreadsheet |
| **AutoML** | You want to predict a column (churn, default, revenue…) or forecast a number over time | Several algorithms compared, the winner tested on unseen rows (or backtested), what drives it in plain language, and a deployed model or a forecast with its range |
| **Workflow** | You want a repeatable automation | A canvas of 32 steps (sources → transforms → quality → ML → AI → outputs), built by hand or from a prompt, run once or on a schedule |
| **Deliver** | People need a dashboard, report or deck regularly | Scheduled delivery by email, Slack, Teams or webhook, with KPI changes since the last send |
| **Pricing** | Checking your balance or buying credits | Balance by bucket, plans, rate card, top-ups, spending controls, history |
| **Docs** | Learning how to use or run it | This guide |

Every report the desk writes can be opened in the **Studio** editors, presented, branded, exported and shared (see *Decks, documents & sharing*).

### How it is built

- **Frontend**: Next.js 14 + Tailwind on port **3010**: public landing page at \`/\`, the desk at \`/app\`
- **Backend**: FastAPI + Uvicorn on port **8002** (REST + Server-Sent Events)
- **Model**: Claude Haiku 5.5 (\`ANTHROPIC_MODEL\`) behind one security checkpoint for every call
- **Agents**: LangGraph planner → CrewAI analytics and marketing crews; a LangChain agent + read-only FastMCP tools for Data chat and the Agent
- **Machine learning**: scikit-learn, XGBoost and LightGBM (AutoML, Model lab, Workflow)
- **Data engineering**: dbt models and tests, optionally scheduled with Airflow (Docker)
`,
  },
  {
    key: "run",
    group: "Getting started",
    title: "Running locally",
    summary: "Start the backend and the frontend, and configure .env",
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

Open **http://localhost:3010**, sign up or log in, and the desk opens at \`/app\`. The frontend calls the backend at \`http://localhost:8002\` (override with \`NEXT_PUBLIC_BACKEND_URL\`).

**3. Airflow** (optional, needs Docker Desktop): generate the setup from *Analytics → Data models*, then

\`\`\`powershell
cd airflow
docker compose up -d --build   # UI at http://localhost:8085
\`\`\`

**If the backend seems stuck at start-up** (no output for minutes, almost no CPU), turn off any VPN and start it again; on this machine a VPN can make reading the Python packages extremely slow.

### Configuration (\`.env\`)

| Variable | Required | Purpose |
|---|---|---|
| \`ANTHROPIC_API_KEY\` | yes | Claude API key |
| \`ANTHROPIC_MODEL\` | no | Defaults to \`claude-haiku-5-5\` |
| \`TAVILY_API_KEY\` | for Agent / marketing | Web search |
| \`POSTGRES_HOST\` / \`PORT\` / \`DB\` / \`USER\` / \`PASSWORD\` | no | Ouroboros's own database (uploads are loaded here when no connection string is given) |
| \`AUTH_REQUIRED\` | no | \`0\` turns off the sign-in requirement for local scripts (default on) |
| \`SMTP_HOST\` · \`SMTP_PORT\` · \`SMTP_USER\` · \`SMTP_PASSWORD\` · \`SMTP_FROM\` | for email delivery | Mail server for *Deliver*. Port 465 uses SSL; any other port uses STARTTLS (\`SMTP_STARTTLS=0\` turns it off) |
| \`PUBLIC_APP_URL\` | no | Link used in delivered messages (default \`http://localhost:3010/app\`) |
| \`EXA_API_KEY\` · \`ZEP_API_KEY\` | no | Knowledge graph enrichment and storage |
| \`AUTO_DASHBOARD\` · \`DBT_MODELING\` | no | Dashboard after each run · dbt before the analytics crew on PostgreSQL (both default \`true\`) |
| \`AIRFLOW_URL\` | no | Airflow API base (default \`http://localhost:8085\`) |
| \`DATACHAT_MASK_PII\` | no | Pseudonymise personal-data columns in Data chat and the Agent (default on) |
| \`PRICING_FILE\` · \`BILLING_ENFORCE\` | no | Pricing file (default \`pricing.json\`) · \`false\` records usage without blocking |
| \`LLM_MAX_PROMPT_CHARS\` · \`LLM_MAX_CALLS_PER_MIN\` · \`LLM_DAILY_TOKEN_BUDGET\` · \`LLM_AUDIT\` | no | Limits of the Claude security checkpoint (900,000 · 150 · 0 = off · true) |
| \`SLACK_BOT_TOKEN\` · \`NOTION_TOKEN\` · \`AIRTABLE_TOKEN\` | no | App connectors; without them, paste a token when importing |
| \`GOOGLE_APPLICATION_CREDENTIALS\` | no | Service-account key for private Google Sheets / Drive files and BigQuery |
| \`BIGQUERY_MAX_BYTES_BILLED\` | no | Most bytes one BigQuery query may bill (default 10 GiB) |
| \`ANALYSIS_MAX_ROWS\` | no | Most rows the Analytics crew loads per table (default 2,000,000) |
| \`GOOGLE_OAUTH_CLIENT_ID\` · \`GOOGLE_OAUTH_CLIENT_SECRET\` · \`SLACK_CLIENT_ID\` · \`SLACK_CLIENT_SECRET\` | no | *Connect Google* / *Connect Slack* sign-in for the connectors |
| \`OAUTH_REDIRECT_BASE\` · \`OAUTH_ENCRYPTION_KEY\` | no | OAuth callback base (default \`http://localhost:8002\`) · key for stored tokens (generated if unset) |
`,
  },
  {
    key: "accounts",
    group: "Getting started",
    title: "Accounts & sign-in",
    summary: "Sign up, log in, sessions",
    body: `
The landing page at **/** is public; everything under **/app** needs an account.

- **Sign up** with an email and a password of at least 8 characters, then you are signed in.
- **Sessions** last 30 days. The session is a random token in an HttpOnly cookie; the server keeps only its SHA-256 hash.
- **Passwords** are hashed with scrypt and a salt per user. Failed log-ins are slowed down per email and per network address.
- **Log out** from the account button at the bottom of the rail. If a session ends, the next request sends you back to the log-in page and then returns you where you were.
- Every API route except sign-up / log-in, share links and the live log needs a signed-in session (otherwise HTTP 401). For local scripts set \`AUTH_REQUIRED=0\`.

Accounts are stored in \`data/auth/users.json\` and \`data/auth/sessions.json\`. All accounts currently share one credit wallet and one history (see *Known limitations*).
`,
  },
  {
    key: "analytics",
    group: "Analytics",
    title: "Running an analysis",
    summary: "Brief, review, and the agent pipeline",
    body: `
1. **Write the brief.** In the left panel describe the business question, then pick a data source: upload files (Excel: every sheet is read, header rows under titles are found and totals removed), paste a database connection string, or import from an app (*From an app*: Google Sheets, Drive, Slack, Notion, Airtable or a file URL).
2. **Start the run.** The *Wire* tab streams the live log.
3. **Review the plan.** LangGraph drafts an analytics plan; a review sheet opens and nothing expensive happens until you approve it. Aborting at review is refunded.
4. **Data engineering.** On PostgreSQL, dbt builds staging and mart models and runs tests; the agents then work on the tested marts.
5. **Analytics crew.** The data scientist picks the method the data supports (time-series forecast, classifier or segmentation); the analyst writes charts and the insight report. Every chart carries a conclusion and an actionable insight.
6. **Dashboard and marketing.** A dashboard is designed automatically, then the marketing crew writes the strategy, ad copy and social posts.

### The agents

| Agent | Job |
|---|---|
| Data Engineer | Profiles the source, builds dbt models and tests |
| Senior Data Scientist | Forecasts, segments, classifiers, SHAP drivers |
| Senior Data Analyst | Problem-driven charts, insight report, PDF and PowerPoint |
| CDO | Reviews and signs off the analytics output |
| Researcher · Planner · Content Creator · CMO | Market research, campaign strategy, ad copy and posts |

### Your database is safe

When you connect your own database, the crew may **create** new tables there (cleaned copies, segments, encoded tables) but it **never overwrites or appends to a table that was already there**: it writes \`<name>_uaa\` instead and continues with that. dbt writes only to its own \`uaa_staging\` / \`uaa_marts\` schemas. Every query the crew writes is a single validated \`SELECT\` in a read-only transaction.
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
| | **Dashboard** | The automatic dashboard with filters |
| | **Analytics** | The insight report; *Edit this report* opens it in the Studio |
| | **Charts** | AI-written interactive charts (Plotly, Altair, Bokeh, Matplotlib), each with a conclusion and an action |
| | **Marketing** · **Content** | Campaign brief, ad copy, social posts; *Edit this campaign* opens the Studio |
| | **Files** | PDF, PowerPoint and Markdown downloads |
| Ask | **Conversation** | Follow-up questions about the finished run |
| | **Graph** | Knowledge graph of entities found in the run |
| Tools | **Data models** | dbt lineage, model SQL, test results, Airflow |
| | **Model lab** | Score new data with any trained model (including AutoML models), SHAP drivers, what-if |
| | **Monitoring** | Data drift monitors (optional webhook alert, public https addresses only) |
| | **Documents** | Question answering over uploaded documents (RAG) |

Finished runs, chat history, dashboards and dbt builds are saved and survive backend restarts. A dot next to a tab means it has new results.
`,
  },
  {
    key: "boards",
    group: "Boards",
    title: "Automatic dashboards",
    summary: "Dashboards designed from files or a database, with chat",
    body: `
**Boards** builds a dashboard from your data in about a minute.

1. **+ New board**: upload files (Excel sheets are all read), connect a database, import from an app, or combine them. Add an optional goal ("weekly sales performance by store").
2. Claude **explores** the data with a few small read-only queries, **designs** KPIs, charts and filters (categories or date ranges), **repairs** any query that fails, and writes an **executive summary** and one insight per chart.
3. **Use it for free:** filter, re-order, rename, change chart types and refresh. None of this calls the AI.
4. **Ask the chat**: questions about what is on screen ("which store fell most?") are answered from the data (up to 3 extra queries); edit requests ("add a margin KPI", "make this a line chart") change the board. Every edit is a new version, so you can undo.
5. **Export** to PowerPoint or Excel, or deliver it on a schedule from *Deliver*.

The upload is checked for data quality first; issues appear with one-click fixes.

| Action | Credits |
|---|---|
| Build a board (explore → design → repair → insights) | 20, refunded if it fails |
| Chat message (question or AI edit) | 3 |
| Filters, layout edits, undo, refresh, exports | Free |

**Security:** every query is one validated \`SELECT\` over the board's own tables; files are queried read-only with a time limit; databases run in a read-only transaction; filter values are checked before they reach SQL; personal-data columns are masked in what Claude sees; the database address is never sent back to the browser.
`,
  },
  {
    key: "metrics",
    group: "Metrics",
    title: "Metrics & data quality",
    summary: "One definition per business metric; checks with one-click fixes",
    body: `
### Metric definitions (the semantic layer)

Define a business metric once and every app uses the same definition: Data chat, the Agent, Boards, Analytics runs and the Workflow builder.

| Field | Example |
|---|---|
| Name · aliases | *Net revenue* · omzet, penjualan bersih |
| Formula (one aggregate) | \`SUM(net_revenue)\` or \`COUNT(DISTINCT customer_id)\` |
| Filter (optional) | \`status = 'paid'\` |
| Format | number, currency (with currency) or percent |

**Test** a definition against a table before saving, or let **Suggest** propose definitions from your columns. Formulas and filters are checked by the SQL guard (one aggregate, one table, no dangerous functions), and definitions are passed to the AI as data, never as instructions.

### Data quality check

Upload a file to get a quality score and a list of issues, each with a severity and, where possible, a **one-click fix** (plain pandas, no AI). Download the cleaned file afterwards. The same check runs on every upload in Analytics and Boards.

| Checks | Fixes |
|---|---|
| Duplicate rows and IDs · missing values · impossible values (negative amounts or ages, percent over 100, future dates) · extreme outliers · inconsistent spellings · gaps in a date series · broken joins between tables | Drop duplicates · keep one row per ID · tidy categories · blank or fill missing values (median, mode, zero) · drop rows · cap outliers |
`,
  },
  {
    key: "datachat",
    group: "Data chat",
    title: "Using Data chat",
    summary: "Connect a file or database and ask questions",
    body: `
1. Click **+ New data chat**.
2. Upload files (CSV · TSV · XLSX · XLS · Parquet · Feather · JSON · JSONL, up to 200 MB each), paste a database connection string and optional schema, or use **Connect an app** to import tables from Google Sheets, Drive, Slack, Notion, Airtable or a file URL.
3. Ask in plain language, or click one of the **suggested questions** in the *Data overview* (a profile of your tables with data-quality notes). Every answer shows the SQL or Python it ran: expand a step to see the code and its output.
4. Click a **follow-up** under the latest answer to keep exploring.
5. Download any table as **Excel / CSV** (the full result) or a chart as **PNG**, and **Pin** results to the **Pinboard**, where *Refresh* re-runs them on current data for free.
6. **Turn this chat into** a deck, Word document or PDF in the Studio.

The **Glossary** holds plain-language business definitions (e.g. *active customer = ordered in the last 90 days*), and saved **Metrics** apply too.

### Why did it change? Forecasts and what-if

- **"Why did revenue drop in September?"** splits the change across every category, names the groups that moved differently, looks one level inside the biggest one and draws a waterfall chart. Compare months, quarters, years, any two date ranges or the same period last year.
- **"Forecast sales for the next 3 months"** gives a forecast with a likely range (80% of outcomes) and how accurate the model was on recent months it had not seen.
- **"What if we raise prices 5%?"** states its assumption, shows the arithmetic and draws the scenario next to the forecast.
- These numbers are calculated in Python, not by the AI. Explanations work on totals; for a ratio they explain the top and the bottom of the fraction.

### The tools (all read-only, from a FastMCP server)

| Tool | What it does |
|---|---|
| \`describe_data\` | Lists datasets, columns, types and which columns are masked |
| \`run_sql\` | One validated \`SELECT\` against the database; the result becomes a DataFrame |
| \`run_python\` | pandas / Plotly code in the session's sandbox; variables persist between questions |

### Example questions

- What are the top 10 products by revenue? Show a bar chart.
- Show monthly revenue for the last 12 months as a line chart.
- Which customer segment has the highest average order value?
- Why did revenue change in March compared with February?
- Forecast monthly revenue for the next quarter. What if we raise prices 5% and lose 4% of orders?

### How long answers take

The **first question** in a new chat is the slowest (the backend loads its libraries and starts the session's Python sandbox). **Follow-ups** are typically 15–30 seconds. Up to 3 sandboxes run at once; switching between many chats restarts older ones.
`,
  },
  {
    key: "databases",
    group: "Data chat",
    title: "Connecting a database",
    summary: "Connection strings, Supabase pooler, troubleshooting",
    body: `
Paste a connection string in Analytics, Boards, Data chat, the Agent, AutoML or a Workflow database step. PostgreSQL, MySQL, SQL Server, Oracle, Redshift, Snowflake, BigQuery and DuckDB are recognised, and so are provider URIs, JDBC and ODBC-style strings; the connection is tested first.

### Snowflake and BigQuery

Click **Connect Snowflake or BigQuery with a form** under the connection field.

- **Snowflake:** account identifier (\`orgname-accountname\`), user, password, warehouse, database, schema and an optional role. Use a role that can only SELECT; each query stops after 60 seconds.
- **BigQuery:** upload the service account's JSON key (Google Cloud → IAM → Service accounts → Keys → Add key → JSON), then the project and dataset. Give the account *BigQuery Data Viewer* and *BigQuery Job User*. The key is stored on the server and the connection string only carries \`?key=…\`. Each query is capped at 10 GiB billed (\`BIGQUERY_MAX_BYTES_BILLED\`).

\`\`\`text
postgresql://USER:PASSWORD@HOST:5432/DATABASE
\`\`\`

### Supabase

Supabase's direct host (\`db.<project>.supabase.co\`) is **IPv6-only** and won't resolve on most IPv4 networks. Use the **Session pooler** URI from *Supabase → Connect → Session pooler*:

\`\`\`text
postgresql://postgres.<project-ref>:PASSWORD@aws-0-<region>.pooler.supabase.com:5432/postgres
\`\`\`

The host is the regional pooler, and the user is \`postgres.<project-ref>\`, not \`postgres\`.

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
Every app can pull data from the tools your team uses: the Analytics brief (*From an app*), Boards, Data chat (*Connect an app*), the Agent (*Bring in data from an app*, placed in the task workspace under \`inputs/\`) and Workflow (*Import from an app*, or the *App data* step, which fetches fresh data on every run). Each import becomes a table, stored like an uploaded file. Documents from Drive (PDF, Word, PowerPoint) become context for Analytics runs and Agent tasks.

| App | What you paste | What you get | Access |
|---|---|---|---|
| **Google Sheets** | The sheet link | The tab in the link, as a table | Link-shared sheets as they are; private ones via *Connect Google* or a service account |
| **Google Drive** | A file link | CSV, Excel, JSON, Parquet as tables; Docs, Slides, PDF, Word as documents | Same as Sheets |
| **Slack** | \`#channel\` or a channel link | One row per message: time, author, text, replies, reactions | *Connect Slack* or a bot token (\`xoxb-…\`) |
| **Notion** | A database link | One row per page, one column per property | Integration secret |
| **Airtable** | A table link (with a view, if you want it filtered) | One row per record | Personal access token |
| **File URL** | A direct link to a file | The file | None; only public addresses (private and internal addresses are refused, on every redirect too) |

Tokens can be pasted in the form (used for that import only, never stored) or set once on the server: \`SLACK_BOT_TOKEN\`, \`NOTION_TOKEN\`, \`AIRTABLE_TOKEN\`. A dot next to an app means the server already has its token.

### Setting up access

- **Google:** either configure *Connect Google* (\`GOOGLE_OAUTH_CLIENT_ID\` / \`SECRET\`), or create a service account, enable the Drive API, set \`GOOGLE_APPLICATION_CREDENTIALS\` to its JSON key and share each file with the service account's email (Viewer).
- **Slack:** configure *Connect Slack* (\`SLACK_CLIENT_ID\` / \`SECRET\`), or create an app with the bot scopes \`channels:history\`, \`channels:read\`, \`groups:history\`, \`groups:read\`, \`users:read\`, install it, copy the *Bot User OAuth Token* and \`/invite\` the bot to each channel.
- **Notion:** create an internal integration at notion.so/my-integrations, then open the database → ••• → *Connections* → add it.
- **Airtable:** create a personal access token with \`data.records:read\` and access to the base.

Imports are capped at 100 MB per file and 200,000 rows per app table, and are a snapshot: import again to refresh.
`,
  },
  {
    key: "agent",
    group: "Agent",
    title: "Using the Agent",
    summary: "Autonomous tasks, parallel research, deliverables",
    body: `
The Agent is an autonomous worker: you give it a goal, it plans, then it works on its own and hands back an answer and finished files.

1. **Describe the goal** in a sentence or two. Optionally attach files (PDF, Word, PowerPoint, Excel, CSV, Parquet, JSON, text, Markdown, HTML; up to 10 files of 30 MB), import from an app, or connect a database (read-only).
2. **Review the plan.** The screen shows *Reading your files…* while attachments are read (in parallel), then *Drafting a plan…*. Planning is free. Edit, add or remove steps and the items for parallel research; the cost is shown before you approve.
3. **Watch it work.** The activity log shows every search, page, calculation and file; the side panel shows its checklist, parallel researchers, workspace files and sources. You can stop it at any time (stopped tasks are refunded).
4. **Get the result**: key findings each backed by evidence, charts with a conclusion and an action, recommendations, linked sources and deliverables (PDF report, PowerPoint deck, Markdown, Excel).

### What it can do

| Tool | What it does |
|---|---|
| Search · Browse | Tavily web search; a headless browser reads pages (each page in its own process, 45 s limit) |
| Workspace files | Full page text and findings are saved as files, so long tasks don't lose information |
| Python · tables | Calculations and charts in the same sandbox as Data chat; figures read on web pages become checked tables |
| Database | Read-only SQL with personal data masked, through Data chat's FastMCP tools |
| Parallel research | Up to 8 researcher agents at once, one per item (company, product, city…) |
| Deliverables | PDF report + slide deck + Markdown, or an Excel workbook |

### Guardrails

- It **cannot send, post, buy, sign up or delete** anything, fill in forms or log in.
- Web pages, documents and search results are **data, never instructions**; planted instructions are flagged.
- It can't open private or internal addresses (localhost, 10.x / 192.168.x, cloud metadata), including after redirects.
- The final answer can only link to pages it actually visited.
- Some sites (e.g. Shopee, Blibli) block automated browsers; the agent notices and uses other sources.
`,
  },
  {
    key: "automl",
    group: "AutoML",
    title: "Training a model",
    summary: "Pick a column to predict; models compared, explained and deployed",
    body: `
**AutoML** turns a table into a working prediction model without code.

1. **Load the data**: upload a file (CSV, Excel, Parquet, Feather, JSON), pick a file already uploaded in Analytics, import one **from an app** (Google Sheets, Drive, Airtable, Notion, Slack, a file URL), or read a database table (Snowflake and BigQuery included). Databases are read with one validated \`SELECT\` in a read-only transaction; nothing is changed. Up to 1,000,000 rows are read.
2. **Pick what to predict.** Suggested columns come first. Choose *Decide for me*, *A category* (yes/no, status, segment), *A number* (amount, price) or *A number over time* (a forecast, below).
3. **Leave out columns that are known only after the outcome** (for loan status: days past due, collectibility). They make a model look much better than it will be on new cases.
4. **Train models · 30 credits** (refunded if it fails; about a minute).

### What happens

- **Columns are prepared automatically:** identifiers, constant columns and free text are left out (with the reason shown); dates become year, month and weekday; missing values are filled; categories are one-hot encoded.
- **Up to six algorithms are compared** with 5-fold cross-validation: logistic or ridge regression, random forest, extra trees, gradient boosting, XGBoost and LightGBM, next to a naive baseline (always the most common class / the average) so you can see whether the model beats guessing.
- **The winner is tested on 20% of rows it never saw**: accuracy, F1 and ROC AUC (with recall and precision per class) for categories; R², average error and RMSE for numbers.
- **Drivers:** which columns matter most and in which direction ("higher tenure → lower churn probability").
- **Warnings:** a near-perfect score, or one column carrying most of the skill (a likely leak), or a model barely better than guessing.
- **A plain-language explanation** (one Claude call that may only use the numbers above), with what to do with the result and its limits.

### Using the model

- **Try a prediction**: change any input and predict, free.
- The model is **deployed** as \`automl_<column>\`: score a whole file in *Analytics → Model lab* or with \`POST /api/predict\`.
- Training runs one at a time; more than 50,000 rows are sampled. Deleting a model also removes its deployed file.

### Forecasting a number over time

1. Choose **A number over time (forecast)**.
2. Pick the **date column**, the **number to forecast** (or **Number of rows** to forecast orders, tickets or transactions), the period (*Decide from the dates*, day, week, month, quarter or year), how many **periods ahead** (default 30 days, 12 weeks, 6 months, 4 quarters or 3 years) and whether rows are **summed** (sales) or **averaged** (prices, rates).
3. **Forecast · 30 credits.** Every row is grouped into periods; a period that isn't finished yet is left out.

Seven methods (naive, seasonal naive, drift, Holt-Winters, Theta, ARIMA and gradient boosting) each forecast the last periods from up to three earlier cut-offs and are compared with what really happened. The leaderboard shows the **average error per period (MAE, lower is better)**; the winner's card adds the error as a percentage (sMAPE) and MASE (below 1 = better than repeating last cycle). You get a chart with the **≈80% range** (from the winner's own backtest errors), a table, a CSV download, the trend and seasonality in plain words, and a Claude explanation.
`,
  },
  {
    key: "workflow",
    group: "Workflow",
    title: "Building workflows",
    summary: "Automations on a canvas, by hand or by prompt",
    body: `
A workflow is a chain of steps that runs your analysis for you. Build it by hand on the canvas, or **describe what you want and AI builds it**.

1. **+ New workflow**, then type in the ✦ AI bar ("Load my sales file, calculate revenue, chart it by region and write a report") or drag steps from the palette.
2. **Connect** steps by dragging from a step's right dot to the next step's left dot. Loops are blocked.
3. **Configure** a step by clicking it. Column fields list the columns available from the step before it.
4. **▶ Run**. The button shows the cost of one run: only Web search (10), AI insights (2), Report with AI text (5), AI classify (5) and Agent task steps are paid; everything else is free. Click a step and open **Output** for its table, chart, text, metrics and files.
5. **Change it with AI**: the AI bar edits an existing workflow ("also export to Excel", "add a forecast").
6. **⏱ Schedule** it hourly, daily or weekly. AI can prepare a schedule, but only you switch it on; the panel shows the estimated credits per month first.

### Steps

| Group | Steps |
|---|---|
| Sources | File · Database query (one read-only SELECT) · Web search · App data (fresh on every run) |
| Transform | Filter · Keep / drop columns · Rename · Clean data · Formula column · Group & summarise · Sort & limit · Join · Append · Pivot · Unpivot · Date tools · Calculate (running total, % change, moving average, rank, share of total) · Bucket values |
| Quality & logic | Data quality check (rules such as \`not_null: customer_id\`) · Condition (continue only if…) |
| Machine learning | Forecast (Holt-Winters + backtest error) · Predict · Segment (K-Means) · Anomaly detection |
| AI | AI insights · AI classify (sentiment / your categories / extract a field) · Agent task |
| Outputs | Chart · Report (PDF + deck + Markdown) · Export file (Excel / CSV) · Send alert (Slack, Teams or webhook; public https addresses only) |

### Good to know

- A failed step skips everything after it; a Condition that isn't met skips the rest without failing the run. Paid steps are charged as they run and refunded if they fail.
- AI steps see a summary of the data with personal-data columns masked; database passwords and webhook URLs are never shown again after saving.
- Schedules run while the backend is running.
`,
  },
  {
    key: "deliver",
    group: "Deliver",
    title: "Scheduled delivery",
    summary: "Dashboards, reports and decks by email, Slack, Teams or webhook",
    body: `
**Deliver** sends a dashboard, report or deck to people on a schedule. Delivery is free: no AI is involved.

1. **+ New delivery** and choose what to send:
   - a **board** from Boards: its queries are re-run first, and the message lists every KPI with its **change since the previous delivery**; optionally attach it as **PowerPoint** and/or **Excel**;
   - a **report or deck** from the Studio (Agent tasks and Analytics runs) as **PDF**, **Word** or **PowerPoint**. Only reports and decks that already exist are offered; open one in the editor once to make it available.
2. **Send to** email (up to 20 recipients), **Slack**, **Microsoft Teams** or a **webhook**.
3. **When**: every day, every week (pick the day) or every month (day 1–28), at a time (server time).
4. Leave **Send one now to test it** ticked to check it straight away.

### Channels

| Channel | What arrives | Setup |
|---|---|---|
| Email | A message with a KPI table and the files attached (up to 15 MB) | \`SMTP_HOST\`, \`SMTP_PORT\`, \`SMTP_USER\`, \`SMTP_PASSWORD\`, \`SMTP_FROM\` in \`.env\`, then restart |
| Slack · Teams | The summary and a link (chat webhooks can't carry files) | An incoming-webhook URL |
| Webhook | JSON with the summary, KPIs, link and, under 5 MB, the files base64-encoded | Any public https URL |

Each delivery card shows the next and last run, and a **history** of the last 20 sends with any error. **Send now**, **Pause / Resume** and **Delete** are on the card. A failed delivery is logged and tried again at the next scheduled time, not in a loop.

**Security:** webhook addresses must be public \`https://\` (private and internal addresses are refused, redirects are not followed) and are masked everywhere after saving; SMTP settings live only in \`.env\`.
`,
  },
  {
    key: "studio",
    group: "Studio",
    title: "Decks, documents & sharing",
    summary: "Edit, present, brand, export and share every report",
    body: `
Every report the desk writes opens in the Studio: from an Agent task (*Edit the result*), an Analytics run (*Edit this report* · *Edit this campaign*) or a Data chat (*Turn this chat into*).

| | Deck | Document |
|---|---|---|
| Edit by hand | Click any text; reorder, duplicate, delete and add slides; 9 layouts (title, section, bullets, two columns, chart, table, big number, quote, chart image); chart data grid; speaker notes | Click any text; add, convert, move and delete blocks (text, heading, bullets, numbered, table, chart, image, quote) |
| Text styles | Bold, italic, underline, strike-through, font, size, colour and highlight | Same |
| Ask AI | *This slide* or *Everything*: "make it shorter", "turn this into a chart", "translate to Bahasa Indonesia" | *This block* or *Everything* |
| Show / export | **Present** full screen (← →, N for notes, Esc); **.pptx** with native, editable charts and tables and speaker notes | **Word** (.docx) and **PDF** |

- **Every visual is explained:** each chart, table and image carries a conclusion and an actionable insight, in the editors and in every export.
- **History:** changes save automatically; the last 30 versions can be restored, or start over from the source. When the source has grown (a chat with new answers), the editor offers to update.
- **Brand kits** (*Brand* menu): colours, heading and body fonts, logo (PNG/JPG up to 2 MB) and footer text, applied on screen and in every export; one kit can be the default.
- **Share links** (*Share*): a read-only link to the latest saved version, optionally expiring (1–90 days) and with comments (never sent to an AI). The token is the permission; turn a link off at any time. Links work for people who can reach this computer (the dialog shows your network address).
- **Deliver** can send a report or deck on a schedule.

Manual editing, presenting and exporting are free; each AI edit costs 3 credits (refunded if it fails) and uses only numbers already in the content.
`,
  },
  {
    key: "security",
    group: "Reference",
    title: "Security & privacy",
    summary: "Read-only data access, PII masking, AI and network safeguards",
    body: `
### Read-only access to your data

- **Data chat and the Agent** reach data only through a read-only **FastMCP** server. Every SQL statement is parsed (sqlglot) and rejected unless it is a single \`SELECT\`: no writes, DDL, \`SELECT INTO\`, row locks, multiple statements, dangerous functions (\`pg_sleep\`, \`dblink\`, \`pg_read_file\`…) or credential/system tables. Accepted queries run in a \`READ ONLY\` transaction with a timeout.
- **Boards, Metrics, Workflow, AutoML and the Analytics crew** use the same SQL guard directly, with read-only transactions and timeouts.
- **Claude reads a profile, not your table:** the Analytics crew computes on every row, but Claude sees only the first 20 rows (personal data masked) plus pandas statistics over all rows; to learn more it runs its own pandas code over the full table in the same sandbox as Data chat, and only results come back. Query results return at most 20 rows.
- **Table and column names chosen by the AI** are checked against the database's real tables and columns before they are used.
- **Your tables are never overwritten:** on a database you connected, the Analytics crew may create tables but never replaces or appends to one that was already there (it writes \`<name>_uaa\` instead). The tables it created are remembered per database (without credentials).
- AI-written code (charts, Data chat, Agent) runs in separate sandboxed processes with no file, network or OS access and no secrets in the environment. The Analytics ETL step can only read CSV files inside the workspace's \`data/\` and \`outputs/\` folders.

### Personal data

- Columns holding names, emails, phone numbers, IDs or addresses are **pseudonymised before the model sees them**; SQL aliases are traced, so \`SELECT email AS x\` stays masked. Free text in results and messages is redacted. You can count and compare people by masked IDs, but the assistant won't reveal real values.

### Every Claude call

One checkpoint wraps every call to Claude, in every feature:

- **Secrets are removed** from prompts and replies (API keys and passwords from the environment, database passwords, common key formats).
- **Limits:** a prompt-size cap, a calls-per-minute circuit breaker that stops runaway agent loops, and an optional daily token budget.
- **Audit:** \`data/audit/llm_calls.jsonl\` records time, feature, model, tokens, flags and latency, never the prompt or reply text.
- Messages are screened for prompt injection; tool output, web pages, documents and data are fenced as untrusted; answers are checked for system-prompt leaks and stripped of external links and images that could leak data.

### Outbound requests (SSRF)

One shared guard checks every address the app is asked to contact: the Agent's browser, file URLs from connectors, Workflow alerts, monitor webhooks and Deliver. Only public addresses pass; localhost, private networks (10.x, 172.16–31.x, 192.168.x, 100.64.x), cloud metadata (169.254.169.254), IPv4-mapped IPv6 forms and addresses with credentials in them are refused. Webhooks must be \`https://\` and redirects are not followed.

### Accounts and storage

- Sign-in with hashed passwords (scrypt) and HttpOnly session cookies; failed log-ins are throttled.
- Secrets stay in \`.env\`; connection passwords and webhook URLs are never returned by the API. \`data/\` is private; only charts and reports under \`outputs/\` are served.
- Every Data chat turn is audit-logged to \`data/audit/datachat_audit.jsonl\` (flags, tools, timing, a message hash, never the content); Data chat allows 20 questions per 5 minutes per chat.
`,
  },
  {
    key: "pricing",
    group: "Reference",
    title: "Pricing & credits",
    summary: "Plans, credits, top-ups and what each action costs",
    body: `
Everything is paid for with **credits** (1 credit = $0.01 / Rp 159 at top-up price; plan credits cost less). Your balance, plan and the live rate card are on the *Pricing* page. All prices come from one file, \`pricing.json\`, which the backend and this UI both read.

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
| Board: build · chat message | 20 · 3 |
| Data chat question | 5 |
| Agent task (includes 8 web searches) | 100, then 10 per extra search |
| Parallel researcher (up to 4 searches each) | 40 |
| AutoML training | 30 |
| Workflow step: Web search · AI insights · Report with AI text · AI classify | 10 · 2 · 5 · 5 per run |
| AI edit of a deck or document | 3 |
| Extra dashboard page · Model lab call · Document Q&A question | 5 · 2 · 3 |

**Free:** planning (Analytics and Agent); board filters, layout edits, undo, refresh and exports; dashboard filtering; building and editing workflows with AI; deterministic workflow steps; editing, presenting and exporting decks and documents by hand; AutoML data loading and test predictions; Scheduled delivery.

### Top-ups

| Pack | Credits | Price |
|---|---|---|
| Small | 1,000 | $10 |
| Medium | 5,000 | $45 |
| Large | 20,000 | $160 |

### How credits are spent

- **Spend order:** rollover → plan → free monthly → signup → top-up, soonest-expiring first.
- **Rollover:** up to 50% of a paid plan's monthly credits carry into the next month. Top-up credits never expire.
- **Refunds are automatic** when work fails, is aborted at review, is stopped, or is blocked by security screening, and when a training or board build fails. Refunds go back to the bucket the credits came from.
- **Low balance:** the request is refused (HTTP 402) and nothing is charged, unless **auto top-up** is on (it buys the smallest pack to stay above 200 credits).
- **Spend cap:** top-ups in one period stop at your cap (default 2× the plan price, $20 on Free); change it under *Spending controls*.
- Set \`BILLING_ENFORCE=false\` to record usage without blocking.

**Checkout is in demo mode**: choosing a plan or buying a pack adds credits without taking payment. Real checkout (Stripe for USD, Xendit or Midtrans for IDR) must grant credits only from a verified payment webhook. The wallet and its history are in \`data/billing/wallet.json\`.
`,
  },
  {
    key: "api",
    group: "Reference",
    title: "API reference",
    summary: "Backend endpoints on port 8002",
    body: `
Interactive docs: **http://localhost:8002/docs**. All routes need a signed-in session cookie except \`/api/auth/*\`, \`/api/share/*\` and \`/api/stream/*\`.

### Accounts

| Method | Endpoint | Description |
|---|---|---|
| POST | \`/api/auth/signup\` · \`/api/auth/login\` · \`/api/auth/logout\` | Sign up · log in · log out (session cookie) |
| GET | \`/api/auth/me\` | The signed-in user |

### Analytics pipeline

| Method | Endpoint | Description |
|---|---|---|
| POST | \`/api/analyze\` | Start a run |
| POST | \`/api/upload\` | Upload files |
| GET | \`/api/stream/{task_id}\` | Live log (SSE) |
| GET | \`/api/status/{task_id}\` · \`/api/results/{task_id}\` · \`/api/tasks\` | Status, results, history |
| POST | \`/api/approve/{task_id}\` | Approve or abort the plan |
| POST | \`/api/chat/{task_id}\` | Conversation about a run |
| GET | \`/api/graph/{task_id}\` | Knowledge graph |

### Boards and Metrics

| Method | Endpoint | Description |
|---|---|---|
| GET · POST | \`/api/autodash\` | List · create a board (files, database, app imports, goal) |
| GET · DELETE | \`/api/autodash/{id}\` · GET \`/api/autodash/jobs/{job}\` | Open or delete a board · build progress |
| POST | \`/api/autodash/{id}/render\` · \`/layout\` · \`/chat\` · \`/restore\` · \`/export\` · \`/quality/fix\` | Filter · edit layout · chat · undo to a version · export · apply a data fix |
| GET · POST · PUT · DELETE | \`/api/metrics…\` | Metric definitions; \`/api/metrics/test\` · \`/api/metrics/suggest\` |
| POST | \`/api/quality/check\` · \`/api/quality/{token}/fix\` · GET \`…/download\` | Data-quality check · fix · download the cleaned file |

### Data chat

| Method | Endpoint | Description |
|---|---|---|
| POST · GET | \`/api/datachat/sessions\` | Start a chat (\`files\`, \`import_ids\` or \`db_uri\` + \`db_schema\`) · list chats |
| GET · DELETE | \`/api/datachat/sessions/{sid}\` | Open or delete a chat |
| POST | \`/api/datachat/sessions/{sid}/message\` | Ask a question |
| GET | \`/api/datachat/sessions/{sid}/overview\` | Data profile with suggested questions |
| GET · PUT | \`/api/datachat/glossary\` | Shared business definitions |
| GET · POST · DELETE | \`/api/datachat/pins…\` | Pinboard; \`/pins/{id}/refresh\` re-runs a pin |

### Agent

| Method | Endpoint | Description |
|---|---|---|
| POST | \`/api/agent/tasks\` · \`/api/agent/tasks/upload\` | Create a task (\`goal\`, optional database, app imports · or with files); Claude drafts a plan |
| GET | \`/api/agent/tasks\` · \`/api/agent/tasks/{id}\` | List tasks · task with \`stage\`, live events, checklist, researchers, files |
| POST | \`/api/agent/tasks/{id}/approve\` · \`/cancel\` | Approve the (edited) plan · stop |
| DELETE | \`/api/agent/tasks/{id}\` | Delete a task and its files |
| GET | \`/api/agent/tasks/{id}/files/{path}\` | Download a workspace file |

### AutoML

| Method | Endpoint | Description |
|---|---|---|
| GET | \`/api/automl/uploads\` | Structured files uploaded in this session |
| POST | \`/api/automl/datasets\` | Load data (\`file\`, or \`file_id\` [+ \`table\`], or \`db_uri\` + \`db_schema\` + \`table\`); returns column profiles and suggested targets |
| GET | \`/api/automl/datasets/{id}\` | A loaded dataset |
| POST · GET | \`/api/automl/jobs\` | Train (\`dataset_id\`, \`target\`, \`task\` auto/classification/regression/forecast, \`exclude\`; forecasts add \`date_column\`, \`horizon\`, \`frequency\`, \`agg\`) · list models |
| POST | \`/api/connectors/bigquery-key\` | Store a BigQuery service-account key; returns \`key_id\` for \`bigquery://project/dataset?key=…\` |
| GET · DELETE | \`/api/automl/jobs/{id}\` | Progress, leaderboard, held-out metrics, drivers, explanation · delete (and its deployed file) |
| POST | \`/api/automl/jobs/{id}/predict\` | Predict one row (\`row\`) |
| GET · POST | \`/api/models\` · \`/api/predict\` | All trained models · score a file with one |

### Scheduled delivery

| Method | Endpoint | Description |
|---|---|---|
| GET | \`/api/delivery/options\` | Boards, reports and decks that can be delivered; whether email is set up |
| GET · POST | \`/api/delivery/schedules\` | List · create (\`item\`, \`channel\`, \`cadence\`, \`name\`) |
| PUT · DELETE | \`/api/delivery/schedules/{id}\` | Change (e.g. \`enabled\`) · delete |
| POST | \`/api/delivery/schedules/{id}/send\` | Send now; returns the history entry |

### Studio and sharing

The same API under \`/api/agent/tasks/{id}/studio\`, \`/api/runs/{run}/studio/{analytics or marketing}\` and \`/api/datachat/sessions/{sid}/studio\`:

| Method | Endpoint | Description |
|---|---|---|
| GET · PUT | \`…/{deck or doc}\` | Editable deck / document (built on first open); save with \`base_version\` |
| POST | \`…/{kind}/ai\` · \`/restore\` · \`/rebuild\` | AI edit · restore a version · start over |
| GET | \`…/{kind}/versions\` · \`/export?format=pptx · docx · pdf\` | Version history · download |
| GET · POST · DELETE | \`/api/brand/kits…\` | Brand kits (and \`/{id}/logo\`) |
| GET · POST | \`/api/share/{token}\` · \`/api/share/{token}/comments\` | View a shared item · comment (public) |
| DELETE | \`/api/shares/{token}\` | Turn a share link off |

### Workflow, data and billing

| Method | Endpoint | Description |
|---|---|---|
| GET · POST | \`/api/workflows\` · \`/api/workflows/catalog\` · \`/api/workflows/generate\` | List · step catalog · build or edit from a prompt |
| GET · PUT · DELETE | \`/api/workflows/{id}\` | Open · save (with schedule) · delete |
| POST | \`/api/workflows/{id}/run\` · \`/files\` · \`/import\` | Run now · upload a file · import from an app |
| POST | \`/api/db/test\` | Test a connection string; list schemas and tables |
| GET · POST | \`/api/connectors\` · \`/api/connectors/import\` | App connectors · import from an app |
| GET · POST | \`/api/dbt/runs…\` · \`/api/dbt/build\` · \`/api/airflow/setup\` · \`/api/airflow/trigger\` | dbt and Airflow |
| POST | \`/api/analyze/drivers\` · \`/api/analyze/whatif\` · \`/api/explore\` · \`/api/rag/query\` | SHAP drivers · what-if · NL → read-only SQL · document Q&A |
| GET · POST · DELETE | \`/api/monitors…\` | Drift monitoring |
| GET | \`/api/billing\` · \`/api/billing/plans\` | Balance, plan, settings, activity · pricing.json |
| POST · PUT | \`/api/billing/subscribe\` · \`/api/billing/topup\` · \`/api/billing/settings\` | Switch plan · buy a pack (demo checkout) · spend cap and auto top-up |
`,
  },
  {
    key: "limits",
    group: "Reference",
    title: "Known limitations",
    summary: "What isn't supported yet",
    body: `
- **Accounts share one wallet and one history:** everyone who signs in sees the same runs, chats, boards and credits. Per-user and per-team separation is not built yet.
- **Demo checkout:** plan changes and top-ups don't take payment until a payment provider is connected.
- **Plan limits on schedules are not enforced** yet: the plans list how many schedules they include, but Workflow and Deliver don't count them.
- **One Analytics run at a time:** each run's database is private to it, but chart files and the tool ledger are still shared, so runs queue; runs are kept in memory and saved to JSON files.
- dbt modelling and Airflow orchestration target **PostgreSQL** (including Supabase, Neon, RDS, Cloud SQL, Azure PostgreSQL).
- **Deliver** sends the latest version of an existing report or deck; it does not re-run an Analytics run on a schedule. Email needs SMTP settings in \`.env\`.
- **AutoML** trains one model at a time and samples above 50,000 rows for categories and numbers; it compares fixed algorithm settings rather than tuning each one. Forecasts cover one series (no per-segment forecasts, holidays or outside drivers).
- Data chat's first question in a new chat is slow (library loading + sandbox start); follow-ups are much faster.
- The Agent can't use sites that block automated browsers (e.g. Shopee, Blibli) and can't log in anywhere.
- App imports are snapshots (import again to refresh); only Workflow's *App data* step fetches fresh data on every run.
- Studio images are limited to the platform's own charts; building a deck for a large report takes up to a minute or two the first time.
- Share links work only for people who can reach the computer running Ouroboros.
- The Analytics *Conversation* tab still runs chart code in-process with keyword filters; Data chat and the Agent use the full sandbox.
- Altair and Bokeh charts are HTML-only, so they don't appear in PDF or PowerPoint exports.
- Schedules (Workflow, Deliver, monitors) run only while the backend is running.
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
