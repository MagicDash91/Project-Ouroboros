"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorText, getJSON, openStream, postJSON } from "./api";
import type { LogEntry, PhaseKey, PhaseState, Results, RunRequest, RunStatus } from "./types";

const MAX_LOGS = 5000;
const PHASES: PhaseKey[] = ["plan", "review", "analytics", "marketing"];

type Phases = Record<PhaseKey, PhaseState>;
const idlePhases = (): Phases => ({ plan: "pending", review: "pending", analytics: "pending", marketing: "pending" });

export interface ReviewRequest {
  report: string;
  deadline: number; // epoch ms when the backend auto-approves
}

interface TaskSummary {
  task_id: string;
  status: string;
  started_at: string;
}

/** Marks `key` active and every earlier non-skipped phase done. */
function advance(p: Phases, key: PhaseKey): Phases {
  const next = { ...p };
  for (const k of PHASES) {
    if (k === key) break;
    if (next[k] !== "skipped") next[k] = "done";
  }
  if (next[key] !== "skipped") next[key] = "active";
  return next;
}

export function useRun(onNotice: (msg: string, tone?: "ok" | "warn" | "bad") => void) {
  const [status, setStatus] = useState<RunStatus>("idle");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [phases, setPhases] = useState<Phases>(idlePhases);
  const [results, setResults] = useState<Results | null>(null);
  const [review, setReview] = useState<ReviewRequest | null>(null);
  const [startedAt, setStartedAt] = useState<string | null>(null);

  const streamRef = useRef<EventSource | null>(null);
  const reviewDoneRef = useRef(false); // the stream replays history, including old hitl_pause events
  const abortedRef = useRef(false);
  const noticeRef = useRef(onNotice);
  noticeRef.current = onNotice;

  const closeStream = useCallback(() => {
    streamRef.current?.close();
    streamRef.current = null;
  }, []);

  const loadResults = useCallback(async (id: string) => {
    try {
      setResults(await getJSON<Results>(`/api/results/${id}`));
    } catch (e) {
      noticeRef.current(`Results could not be loaded: ${errorText(e)}`, "warn");
    }
  }, []);

  const finish = useCallback(
    (id: string, outcome: "completed" | "error" | "aborted", message?: string) => {
      closeStream();
      setReview(null);
      setStatus(outcome);
      if (outcome === "completed") {
        setPhases((p) => {
          const next = { ...p };
          for (const k of PHASES) if (next[k] !== "skipped") next[k] = "done";
          return next;
        });
        noticeRef.current("Pipeline complete", "ok");
        loadResults(id);
      } else if (outcome === "error") {
        noticeRef.current(message ? `Pipeline failed: ${message}` : "Pipeline failed. See the console.", "bad");
      } else {
        noticeRef.current("Pipeline aborted", "warn");
      }
    },
    [closeStream, loadResults],
  );

  const handleEvent = useCallback(
    (id: string, d: LogEntry) => {
      if (d.type === "heartbeat") return;
      if (d.type === "hitl_pause") {
        if (reviewDoneRef.current) return;
        setStatus("awaiting");
        setPhases((p) => advance(p, "review"));
        const secs = d.auto_approve_secs ?? 600;
        const started = d.timestamp ? Date.parse(d.timestamp) : Date.now();
        setReview({ report: d.preliminary_report || d.plan_preview || "", deadline: started + secs * 1000 });
        return;
      }
      if (d.type === "complete") return finish(id, "completed");
      if (d.type === "aborted") return finish(id, "aborted");
      if (d.type === "error") {
        // The backend reports an abort as status "error" ("Analysis aborted by user…"), so
        // check the recorded reason before calling it a failure.
        getJSON<{ status: string; error?: string }>(`/api/status/${id}`)
          .then((s) => {
            const aborted = abortedRef.current || s.status === "aborted" || /aborted by user/i.test(s.error || "");
            finish(id, aborted ? "aborted" : "error", d.message || s.error);
          })
          .catch(() => finish(id, abortedRef.current ? "aborted" : "error", d.message));
        return;
      }

      const msg = d.message || "";
      if (/HITL: Approved|proceeding to Phase 2/i.test(msg)) {
        reviewDoneRef.current = true;
        setReview(null); // a replayed hitl_pause may have opened it moments ago
        setStatus("running");
        setPhases((p) => advance(p, "analytics"));
      } else if (/Phase 2 complete/i.test(msg)) {
        setPhases((p) => ({ ...p, analytics: "done" }));
      } else if (/PHASE 3|Phase 3a/.test(msg)) {
        setPhases((p) => advance(p, "marketing"));
      }
      setLogs((prev) => (prev.length >= MAX_LOGS ? [...prev.slice(-MAX_LOGS + 1), d] : [...prev, d]));
    },
    [finish],
  );

  const attach = useCallback(
    (id: string) => {
      closeStream();
      setLogs([]); // the stream replays the full log history on connect
      const es = openStream(id);
      streamRef.current = es;
      es.onmessage = (ev) => {
        try {
          handleEvent(id, JSON.parse(ev.data));
        } catch {
          /* ignore malformed frames */
        }
      };
      es.onerror = () => {
        // EventSource retries on its own; if the task already ended, settle via /status.
        getJSON<{ status: string; error?: string }>(`/api/status/${id}`)
          .then((s) => {
            if (s.status === "completed") finish(id, "completed");
            else if (s.status === "error") finish(id, "error", s.error);
            else if (s.status === "aborted") finish(id, "aborted");
          })
          .catch(() => undefined);
      };
    },
    [closeStream, finish, handleEvent],
  );

  // On load, resume the most recent task so a page refresh doesn't lose the run.
  useEffect(() => {
    let cancelled = false;
    getJSON<TaskSummary[]>("/api/tasks")
      .then((tasks) => {
        if (cancelled || !tasks.length) return;
        const latest = [...tasks].sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
        setTaskId(latest.task_id);
        setStartedAt(latest.started_at);
        if (latest.status === "running" || latest.status === "awaiting_approval") {
          setStatus(latest.status === "running" ? "running" : "awaiting");
          setPhases(advance(idlePhases(), latest.status === "running" ? "plan" : "review"));
          attach(latest.task_id);
        } else {
          getJSON<{ logs: LogEntry[] }>(`/api/logs/${latest.task_id}`)
            .then((r) => !cancelled && setLogs(r.logs.filter((l) => l.type !== "hitl_pause").slice(-MAX_LOGS)))
            .catch(() => undefined);
          if (latest.status === "completed") {
            setStatus("completed");
            setPhases({ plan: "done", review: "done", analytics: "done", marketing: "done" });
            loadResults(latest.task_id);
          } else {
            getJSON<{ error?: string }>(`/api/status/${latest.task_id}`)
              .then((s) => !cancelled && setStatus(/aborted by user/i.test(s.error || "") ? "aborted" : "error"))
              .catch(() => !cancelled && setStatus("error"));
          }
        }
      })
      .catch(() => undefined); // backend not up yet; the Run button will surface errors
    return () => {
      cancelled = true;
      closeStream();
    };
  }, [attach, closeStream, loadResults]);

  const start = useCallback(
    async (req: RunRequest) => {
      setResults(null);
      setReview(null);
      reviewDoneRef.current = false;
      abortedRef.current = false;
      setPhases(
        req.use_langgraph
          ? advance(idlePhases(), "plan")
          : { plan: "skipped", review: "skipped", analytics: "active", marketing: "pending" },
      );
      setStatus("running");
      try {
        const { task_id } = await postJSON<{ task_id: string }>("/api/analyze", req);
        setTaskId(task_id);
        setStartedAt(new Date().toISOString());
        attach(task_id);
      } catch (e) {
        setStatus("error");
        setPhases(idlePhases());
        noticeRef.current(`Could not start: ${errorText(e)}`, "bad");
      }
    },
    [attach],
  );

  const decide = useCallback(
    async (abort: boolean) => {
      if (!taskId) return;
      reviewDoneRef.current = true;
      abortedRef.current = abort;
      setReview(null);
      try {
        await postJSON(`/api/approve/${taskId}`, { abort });
        if (!abort) {
          setStatus("running");
          setPhases((p) => advance(p, "analytics"));
        }
      } catch (e) {
        noticeRef.current(`Decision not recorded: ${errorText(e)}`, "bad");
      }
    },
    [taskId],
  );

  const clearLogs = useCallback(() => setLogs([]), []);

  return { status, taskId, logs, phases, results, review, startedAt, start, decide, clearLogs };
}
