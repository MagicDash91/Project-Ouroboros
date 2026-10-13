// Hand-off between apps: Home (or any view) leaves an "intent" and switches app; the target view picks it up
// whether it is already mounted (event) or mounts later (sessionStorage).

import type { ImportedFile, UploadedFile } from "./types";

export type Intent =
  | { type: "open_chat"; sid: string }
  | { type: "prefill_analysis"; request: string; files: (UploadedFile & { size?: number })[] }
  | { type: "prefill_agent"; goal: string; files: ImportedFile[] }
  | { type: "open_workflow"; id: string };

const KEY = "ouro:intent";
const EVENT = "ouro:intent";

export function sendIntent(intent: Intent) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(intent));
  } catch {
    // storage blocked: the event below still reaches mounted views
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: intent }));
}

/** Calls `handle` for intents of the given types (a pending one first), consuming them. Returns a cleanup. */
export function onIntent(types: Intent["type"][], handle: (i: Intent) => void): () => void {
  const take = (i: Intent | null) => {
    if (!i || !types.includes(i.type)) return;
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      // ignore
    }
    handle(i);
  };
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) take(JSON.parse(raw) as Intent);
  } catch {
    // ignore
  }
  const listener = (e: Event) => take((e as CustomEvent<Intent>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
