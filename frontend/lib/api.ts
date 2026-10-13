// Thin client for the FastAPI backend. Same-origin paths go through the Next.js
// rewrite (next.config.mjs); the SSE stream connects to the backend directly.

export const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8002";

export class ApiError extends Error {}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      // FastAPI always answers with JSON, so a non-JSON 5xx comes from the Next.js
      // proxy failing to reach it — usually the backend simply isn't running.
      if (res.status >= 500) detail = `Backend not reachable at ${BACKEND_URL}. Is it running?`;
    }
    throw new ApiError(detail);
  }
  return res.json() as Promise<T>;
}

export function getJSON<T>(path: string): Promise<T> {
  return fetch(path, { cache: "no-store" }).then((r) => parse<T>(r));
}

export function postJSON<T>(path: string, body?: unknown): Promise<T> {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => parse<T>(r));
}

export function putJSON<T>(path: string, body: unknown): Promise<T> {
  return fetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => parse<T>(r));
}

export function postForm<T>(path: string, form: FormData): Promise<T> {
  return fetch(path, { method: "POST", body: form }).then((r) => parse<T>(r));
}

export function del<T>(path: string): Promise<T> {
  return fetch(path, { method: "DELETE" }).then((r) => parse<T>(r));
}

export function openStream(taskId: string): EventSource {
  return new EventSource(`${BACKEND_URL}/api/stream/${taskId}`);
}

export const formatBytes = (b?: number) =>
  !b ? "" : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
