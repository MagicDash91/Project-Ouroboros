/** The page's one motif: the ouroboros as a flat ring (an annulus in currentColor). */
export function Ring({ className, width = 14 }: { className?: string; width?: number }) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true" focusable="false">
      <circle cx="50" cy="50" r={50 - width / 2} fill="none" stroke="currentColor" strokeWidth={width} />
    </svg>
  );
}

/** The motif at text size: a small ring used as the list bullet. */
export function RingDot({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`inline-block h-[0.62em] w-[0.62em] shrink-0 rounded-full border-[0.16em] border-current ${className}`} />;
}
