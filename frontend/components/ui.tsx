"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
export { cx };

type Tone = "ink" | "signal" | "line" | "quiet";

export function Button({
  tone = "line",
  size = "md",
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; size?: "sm" | "md" | "lg" }) {
  return (
    <button
      {...rest}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-[3px] font-medium transition-[background,color,border-color,transform] duration-150 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40",
        size === "sm" && "h-7 px-2.5 text-[12px]",
        size === "md" && "h-9 px-3.5 text-[13px]",
        size === "lg" && "h-11 px-5 text-[14px]",
        tone === "ink" && "bg-ink text-paper hover:bg-graphite",
        tone === "signal" && "bg-signal text-white hover:bg-ink",
        tone === "line" && "border border-ink/80 text-ink hover:bg-ink hover:text-paper",
        tone === "quiet" && "text-graphite hover:bg-ink/5 hover:text-ink",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="label mb-1.5 block">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-mute">{hint}</span>}
    </label>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  note,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  note?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-start justify-between gap-4 text-left"
    >
      <span>
        <span className="block text-[13px] text-ink">{label}</span>
        {note && <span className="block text-[11.5px] leading-snug text-mute">{note}</span>}
      </span>
      <span
        className={cx(
          "relative mt-0.5 h-[18px] w-8 shrink-0 rounded-full border transition-colors",
          checked ? "border-ink bg-ink" : "border-rule bg-sheet",
        )}
      >
        <span
          className={cx(
            "absolute top-[2px] h-3 w-3 rounded-full transition-transform",
            checked ? "translate-x-[15px] bg-paper" : "translate-x-[2px] bg-mute",
          )}
        />
      </span>
    </button>
  );
}

/** Kicker + serif headline, used at the top of every section. */
export function SectionHead({ kicker, title, aside }: { kicker: string; title: ReactNode; aside?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-wrap items-end justify-between gap-4 border-b border-ink pb-4">
      <div>
        <div className="label mb-2 text-signal">{kicker}</div>
        <h2 className="font-serif text-[2rem] font-medium leading-[1.05] tracking-[-0.015em]">{title}</h2>
      </div>
      {aside}
    </header>
  );
}

/** Empty states read as a sentence, not an icon and a shrug. */
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rise max-w-md py-16">
      <p className="font-serif text-[1.6rem] italic leading-tight text-graphite">{title}</p>
      {children && <div className="mt-3 text-[13px] leading-relaxed text-mute">{children}</div>}
    </div>
  );
}

export function Working({ label = "Working" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 font-mono text-[12px] text-graphite">
      <span className="blink inline-block h-3 w-1.5 bg-signal" />
      {label}
    </span>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="border-l-2 border-signal bg-signal/5 px-3 py-2 text-[13px] text-signal">{children}</div>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("rounded-[3px] border border-rule bg-sheet", className)}>{children}</div>;
}

/** Plain data table for API rows (prediction preview, SQL results). */
export function DataTable({ rows, maxCols = 10, maxRows = 15 }: { rows: Record<string, unknown>[]; maxCols?: number; maxRows?: number }) {
  if (!rows?.length) return null;
  const cols = Object.keys(rows[0]).slice(0, maxCols);
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full border-collapse font-mono text-[12px] tabular-nums">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} className="border-b-[1.5px] border-ink py-1.5 pr-4 text-left font-sans text-[10.5px] font-semibold uppercase tracking-[0.1em] text-mute">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, maxRows).map((r, i) => (
            <tr key={i} className="border-b border-rule">
              {cols.map((c) => (
                <td key={c} className="whitespace-nowrap py-1.5 pr-4 text-ink/85">
                  {String(r[c] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > maxRows && <p className="mt-1.5 text-[11.5px] text-mute">Showing {maxRows} of {rows.length} rows</p>}
    </div>
  );
}
