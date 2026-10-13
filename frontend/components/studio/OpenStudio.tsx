"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { DeckEditor } from "./DeckEditor";
import { DocEditor } from "./DocEditor";

/** "Edit & present deck" / "Edit document" for one report; the editors open full screen over the app. */
export function OpenStudio({ prefix, label = "Edit the result", note }: { prefix: string; label?: string; note?: string }) {
  const [open, setOpen] = useState<"deck" | "doc" | null>(null);
  return (
    <div>
      <div className="label mb-2">{label}</div>
      <div className="grid grid-cols-2 gap-1.5">
        <button
          onClick={() => setOpen("deck")}
          className="border border-ink bg-ink px-3 py-2.5 text-left text-paper transition-colors hover:border-signal hover:bg-signal"
        >
          <span className="block text-[12.5px] font-medium">Edit &amp; present deck</span>
          <span className="block text-[10.5px] text-paper/60">Slides · export .pptx</span>
        </button>
        <button
          onClick={() => setOpen("doc")}
          className="border border-ink bg-white px-3 py-2.5 text-left text-ink transition-colors hover:bg-ink hover:text-paper"
        >
          <span className="block text-[12.5px] font-medium">Edit document</span>
          <span className="block text-[10.5px] opacity-60">Word · PDF</span>
        </button>
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-mute">
        {note ?? "Change anything by hand or ask the AI. Changes save automatically, with history."}
      </p>
      {open === "deck" && createPortal(<DeckEditor prefix={prefix} onClose={() => setOpen(null)} />, document.body)}
      {open === "doc" && createPortal(<DocEditor prefix={prefix} onClose={() => setOpen(null)} />, document.body)}
    </div>
  );
}
