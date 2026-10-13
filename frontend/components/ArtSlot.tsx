"use client";

import { useEffect, useState } from "react";
import { cx } from "@/components/ui";

/**
 * A slot for an illustration. Drop a file named `<name>.webp|.png|.jpg|.svg` into
 * frontend/public/art/ and it appears here; until then a quiet tinted placeholder holds the space.
 */

const EXTS = ["webp", "png", "jpg", "svg"];

const TINTS = {
  clay: "bg-[#e3c9b4]",
  oat: "bg-[#e8dfcf]",
  sage: "bg-[#c9d3c0]",
  sky: "bg-[#c8d4dc]",
  rose: "bg-[#e2c3c0]",
  sand: "bg-[#ddd0b3]",
} as const;

export type Tint = keyof typeof TINTS;

export function ArtSlot({ name, alt, tint = "oat", className }: { name: string; alt: string; tint?: Tint; className?: string }) {
  // undefined = still looking, null = no file. Probed in the browser after mount: an <img> that 404s
  // during server render fails before React attaches onError, which left a broken image stuck on screen.
  const [src, setSrc] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    const tryExt = (i: number) => {
      if (i >= EXTS.length) return alive && setSrc(null);
      const url = `/art/${name}.${EXTS[i]}`;
      const probe = new Image();
      probe.onload = () => alive && setSrc(url);
      probe.onerror = () => tryExt(i + 1);
      probe.src = url;
    };
    tryExt(0);
    return () => {
      alive = false;
    };
  }, [name]);

  return (
    <div className={cx("relative overflow-hidden", TINTS[tint], className)}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} className="absolute inset-0 h-full w-full object-cover" />
      ) : src === null ? (
        <Placeholder name={name} />
      ) : null}
    </div>
  );
}

/** Horizon, a floating sun and a long shadow: a placeholder that reads as intentional, not broken. */
function Placeholder({ name }: { name: string }) {
  return (
    <div className="absolute inset-0" aria-hidden>
      <svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" className="h-full w-full">
        <line x1="0" y1="205" x2="400" y2="205" stroke="currentColor" strokeWidth="1" className="text-ink/25" />
        <circle cx="250" cy="110" r="38" fill="none" stroke="currentColor" strokeWidth="1.2" className="text-ink/35" />
        <ellipse cx="250" cy="232" rx="54" ry="5" fill="currentColor" className="text-ink/10" />
        <path d="M120 205 q12 -48 24 0" fill="none" stroke="currentColor" strokeWidth="1" className="text-ink/25" />
      </svg>
      <span className="absolute bottom-2.5 left-3 font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink/40">art · {name}</span>
    </div>
  );
}
