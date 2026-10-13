// Shapes returned by the FastAPI backend (app.py). Optional fields are ones the
// backend fills only when that stage of the pipeline produced output.

export type RunStatus = "idle" | "running" | "awaiting" | "completed" | "error" | "aborted";

export type PhaseKey = "plan" | "review" | "analytics" | "marketing";
export type PhaseState = "pending" | "active" | "done" | "skipped";

export interface LogEntry {
  type: string;
  message?: string;
  timestamp?: string;
  task_id?: string;
  plan_preview?: string;
  preliminary_report?: string;
  auto_approve_secs?: number;
}

export interface UploadedFile {
  file_id: string;
  filename: string;
  type: "structured" | "document";
  rows?: number;
  columns?: string[];
  word_count?: number;
}

/** A file brought in from an app by POST /api/connectors/import; used exactly like an upload. */
export interface ImportedFile extends UploadedFile {
  source: string;
  size: number;
}

export interface ConnectorStatus {
  key: "gsheets" | "gdrive" | "slack" | "notion" | "airtable" | "url";
  name: string;
  env: string;
  configured: boolean;
  needs_token: boolean;
}

export interface ReportFile {
  name: string;
  url: string;
  ext: string;
  size?: number;
}

export interface ChartFile {
  name: string;
  url: string;
}

export interface BlogSection {
  title?: string;
  chart_url?: string;
  gemini_analysis?: string;
  analysis?: string;
  nvidia_recommendations?: string;
}

export interface ContentItem {
  type: "poster" | "social_post" | "ad_copy" | string;
  title?: string;
  platform?: string;
  content?: string;
  poster_url?: string;
}

export interface Results {
  task_id: string;
  banking_report: string;
  banking_blog_sections: BlogSection[];
  banking_charts: ChartFile[];
  marketing_report: string;
  campaign_brief: string;
  marketing_content_items: ContentItem[];
  all_reports: ReportFile[];
  dashboard_id?: string | null;
  dbt_run_id?: string | null;
  completed_at?: string;
}

// ── dbt data models (/api/dbt) and Airflow (/api/airflow) ───────────────────
export interface DbtModel {
  name: string;
  layer: "staging" | "intermediate" | "marts" | string;
  description: string;
  relation: string;
  status: string;
}

export interface DbtTest {
  node: string;
  name: string;
  model: string;
  status: string;
  message: string;
  seconds: number;
}

export interface DbtRun {
  id: string;
  created_at: string;
  trigger: string;
  goal: string;
  sources: string[];
  models: DbtModel[];
  tests: DbtTest[];
  lineage: [string, string][];
  ok: boolean;
  repaired: string[];
  llm_usage?: { calls: number; input_tokens: number; output_tokens: number };
}

export interface DbtRunSummary {
  id: string;
  created_at: string;
  ok: boolean;
  goal: string;
  trigger: string;
  models: number;
  tests_passed: number;
  tests_total: number;
}

export interface DbtModelSource {
  name: string;
  layer: string;
  sql: string;
  doc: { description?: string; columns?: { name: string; description?: string; data_tests?: unknown[] }[] };
}

export interface AirflowStatus {
  configured: boolean;
  reachable: boolean;
  ui_url?: string;
  dag_id?: string;
  schedule?: string | null;
  paused?: boolean;
  runs?: { run_id: string; state: string; start?: string | null; end?: string | null; trigger?: string }[];
  message?: string;
}

// ── Automatic dashboards (/api/dashboards) ──────────────────────────────────
export type ValueFormat = "number" | "percent" | "currency" | "decimal";

export interface DashKpi {
  id: string;
  label: string;
  format: ValueFormat;
  note?: string;
}

export interface DashChart {
  id: string;
  title: string;
  type: "bar" | "hbar" | "line" | "pie" | "table";
  x: string;
  y: string[];
  y_format?: ValueFormat;
  note?: string;
}

export interface DashboardSpec {
  title: string;
  summary: string;
  currency?: string;
  kpis: DashKpi[];
  charts: DashChart[];
  filters: string[];
}

export interface Dashboard {
  id: string;
  created_at: string;
  brief: string;
  source: { table: string; label?: string };
  spec: DashboardSpec;
  llm_usage?: { calls: number; input_tokens: number; output_tokens: number };
}

export interface DashboardSummary {
  id: string;
  title: string;
  created_at: string;
  table: string;
  label?: string;
  tiles: number;
}

export interface DashboardData {
  id: string;
  filters: Record<string, { value: string; count: number }[]>;
  applied: Record<string, string[]>;
  row_count: number;
  kpis: { id: string; value: number | string | null; error?: string }[];
  charts: { id: string; rows: Record<string, unknown>[]; error?: string }[];
  refreshed_at: string;
}

export interface DbTestResult {
  ok: boolean;
  engine?: string;
  provider?: string;
  masked?: string;
  version?: string;
  error?: string;
  hint?: string | null;
  schemas?: { name: string; visible: boolean; tables: { name: string; rows: number | null; view: boolean }[] }[];
}

export interface RunRequest {
  database_uri: string;
  database_schema?: string;
  uploaded_file_ids: string[];
  analysis_request: string;
  use_langgraph: boolean;
  brand_name: string;
  industry: string;
  target_audience: string;
  campaign_goals: string;
  budget: string;
  campaign_type: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  charts?: string[];
  flags?: string[];
  error?: boolean;
}

export interface GraphNode {
  id: string | number;
  label: string;
  group?: string;
  title?: string;
  sentiment?: string;
}

export interface GraphEdge {
  from: string | number;
  to: string | number;
  label?: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  analysis?: string;
}

export interface ModelInfo {
  filename: string;
  model_type?: string;
  created?: string;
}

export interface Monitor {
  id: string;
  name: string;
  table: string;
  interval_minutes: number;
  alert_count?: number;
  last_status?: string;
  last_run?: string;
}

export interface Finding {
  detail: string;
}

// ── Data chat (features/data_chat.py) ────────────────────────────────────────

export interface DataChatTable {
  type?: "table";
  shape: number[];
  columns: string[];
  rows: unknown[][];
  /** Full result saved for download (/api/datachat/sessions/{id}/tables/{ref}). */
  ref?: string;
}

export interface DataChatStep {
  tool: "python" | "sql";
  input: string;
  ok: boolean;
  error?: string;
  table?: DataChatTable;
  charts?: string[];
  saved_as?: string;
}

export interface DataChatChart {
  url: string;
  kind: "html" | "png";
}

export interface DataChatMessage {
  role: "user" | "assistant";
  content: string;
  steps?: DataChatStep[];
  charts?: DataChatChart[];
  tables?: DataChatTable[];
  seconds?: number;
  error?: boolean;
  security?: string[];
  blocked?: boolean;
  followups?: string[];
}

export interface DataChatDataset {
  name: string;
  rows: number | null;
  columns: [string, string][];
  masked?: Record<string, string>;
}

export interface DataChatSession {
  id: string;
  title: string;
  created_at: string;
  history: DataChatMessage[];
  datasets: DataChatDataset[];
  sql_frames: { name: string; rows: number; masked?: Record<string, string> }[];
  source: { kind: "files" | "database"; label: string; files: { name: string; format: string; size: number }[] };
  overview?: DataChatOverview;
}

export interface DataChatOverview {
  summary: string;
  issues: string[];
  questions: string[];
  tables: {
    name: string;
    rows: number | null;
    columns: number;
    dates: { column: string; from: string; to: string }[];
    missing: { column: string; count: number }[];
  }[];
  created_at: string;
}

export interface GlossaryTerm {
  term: string;
  definition: string;
}

export interface DataChatPin {
  id: string;
  sid: string;
  chat: string;
  question: string;
  turn: number;
  kind: "chart" | "table";
  index: number;
  chart?: DataChatChart;
  table?: DataChatTable;
  created_at: string;
  refreshed_at: string | null;
}

export interface DataChatSummary {
  id: string;
  title: string;
  created_at: string;
  kind: "files" | "database";
  messages: number;
}
