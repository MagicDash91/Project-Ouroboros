"use client";

/* What-you-see text editing for the Studio (decks and documents), like a word processor.

   Storage stays plain marker text — never HTML — so the AI, the exports (pptx/docx/pdf, features/studio.py
   `runs`) and the share page read exactly the same thing:
     **bold**  *italic*  ++underline++  ~~strikethrough~~
     {{f=Georgia;s=14;c=#c0392b;bg=#fff2a8|text}}   font, size (pt), colour, highlight for a stretch of text
   The DOM is only a view: every keystroke is read back into markers. Sizes are drawn as
   calc(var(--pt) * N) so the same text is in points on a page and scales with the slide on a deck
   (the slide sets --pt to a container-width unit). */

import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { cx } from "../ui";

export const FONTS = [
  "Calibri",
  "Arial",
  "Segoe UI",
  "Verdana",
  "Tahoma",
  "Trebuchet MS",
  "Georgia",
  "Times New Roman",
  "Garamond",
  "Cambria",
  "Palatino Linotype",
  "Courier New",
  "Consolas",
] as const;
export const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 60, 72, 96];

export interface Run {
  text: string;
  b: boolean;
  i: boolean;
  u: boolean;
  s: boolean;
  font?: string;
  size?: number;
  color?: string;
  bg?: string;
}
type Toggle = "b" | "i" | "u" | "s";
type SpanStyle = Pick<Run, "font" | "size" | "color" | "bg">;
const TOGGLES: [string, Toggle][] = [
  ["**", "b"],
  ["++", "u"],
  ["~~", "s"],
  ["*", "i"],
];
const SPAN_OPEN = /\{\{([a-z]+=[^|{}]{1,40}(?:;[a-z]+=[^|{}]{1,40}){0,4})\|/y;
const HEX = /^#[0-9a-f]{6}$/i;

function spanStyle(spec: string): SpanStyle {
  const out: SpanStyle = {};
  for (const part of spec.split(";")) {
    const [k, v = ""] = part.split("=");
    const val = v.trim();
    if (k === "f" && (FONTS as readonly string[]).includes(val)) out.font = val;
    else if (k === "s" && Number(val) >= 6 && Number(val) <= 120) out.size = Number(val);
    else if (k === "c" && HEX.test(val)) out.color = val.toLowerCase();
    else if (k === "bg" && HEX.test(val)) out.bg = val.toLowerCase();
  }
  return out;
}

const sameStyle = (a: Run, b: Run) =>
  a.b === b.b && a.i === b.i && a.u === b.u && a.s === b.s && a.font === b.font && a.size === b.size && a.color === b.color && a.bg === b.bg;

/** Marker text → runs (mirrors features/studio.py `runs`). */
export function parse(text: string): Run[] {
  const src = text || "";
  const out: Run[] = [];
  const flags = { b: false, i: false, u: false, s: false };
  const spans: SpanStyle[] = [];
  let buf = "";
  const push = () => {
    if (!buf) return;
    const run: Run = { text: buf, ...flags, ...(Object.assign({}, ...spans) as SpanStyle) };
    const last = out[out.length - 1];
    if (last && sameStyle(last, run)) last.text += buf;
    else out.push(run);
    buf = "";
  };
  let i = 0;
  while (i < src.length) {
    SPAN_OPEN.lastIndex = i;
    const m = SPAN_OPEN.exec(src);
    if (m && src.indexOf("}}", SPAN_OPEN.lastIndex) > 0) {
      push();
      spans.push(spanStyle(m[1]));
      i = SPAN_OPEN.lastIndex;
      continue;
    }
    if (spans.length && src.startsWith("}}", i)) {
      push();
      spans.pop();
      i += 2;
      continue;
    }
    const t = TOGGLES.find(([mk]) => src.startsWith(mk, i));
    if (t) {
      const [mk, k] = t;
      const after = i + mk.length;
      const opening = !flags[k];
      const ok = opening ? after < src.length && !/\s/.test(src[after]) && src.indexOf(mk, after + 1) > 0 : true;
      if (ok) {
        push();
        flags[k] = opening;
        i = after;
        continue;
      }
    }
    buf += src[i++];
  }
  push();
  return out;
}

const spanKey = (r: Run) =>
  [r.font && `f=${r.font}`, r.size && `s=${r.size}`, r.color && `c=${r.color}`, r.bg && `bg=${r.bg}`].filter(Boolean).join(";");

/** Runs → marker text (inverse of parse). */
export function serialize(list: Run[]): string {
  const groups: { key: string; runs: Run[] }[] = [];
  for (const r of list.filter((x) => x.text)) {
    const key = spanKey(r);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.runs.push(r);
    else groups.push({ key, runs: [r] });
  }
  return groups
    .map(({ key, runs }) => {
      const inner = runs
        .map((r) => {
          // Markers hug the words: keep edge spaces outside so "** x **" never happens.
          const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(r.text) ?? ["", "", r.text, ""];
          if (!core) return r.text;
          let t = core;
          if (r.i) t = `*${t}*`;
          if (r.s) t = `~~${t}~~`;
          if (r.u) t = `++${t}++`;
          if (r.b) t = `**${t}**`;
          return lead + t + trail;
        })
        .join("");
      return key ? `{{${key}|${inner}}}` : inner;
    })
    .join("");
}

export function plainText(text: string): string {
  return parse(text)
    .map((r) => r.text)
    .join("");
}

export const ptSize = (n: number) => `calc(var(--pt, 1pt) * ${n})`;

export function runCss(r: Partial<Run>): CSSProperties {
  const deco = [r.u && "underline", r.s && "line-through"].filter(Boolean).join(" ");
  return {
    ...(r.b ? { fontWeight: 600 } : {}),
    ...(r.i ? { fontStyle: "italic" } : {}),
    ...(deco ? { textDecorationLine: deco } : {}),
    ...(r.font ? { fontFamily: r.font } : {}),
    ...(r.size ? { fontSize: ptSize(r.size) } : {}),
    ...(r.color ? { color: r.color } : {}),
    ...(r.bg ? { backgroundColor: r.bg } : {}),
  };
}

/** Read-only rendering of marker text. */
export function Inline({ text }: { text: string }) {
  return (
    <>
      {parse(text).map((r, k) => {
        const css = runCss(r);
        return Object.keys(css).length ? (
          <span key={k} style={css}>
            {r.text}
          </span>
        ) : (
          <Fragment key={k}>{r.text}</Fragment>
        );
      })}
    </>
  );
}

// ── DOM ↔ markers ───────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CSS_NAMES: Record<string, string> = {
  fontWeight: "font-weight",
  fontStyle: "font-style",
  textDecorationLine: "text-decoration-line",
  fontFamily: "font-family",
  fontSize: "font-size",
  color: "color",
  backgroundColor: "background-color",
};

function cssText(r: Run): string {
  return Object.entries(runCss(r))
    .map(([k, v]) => `${CSS_NAMES[k]}:${k === "fontFamily" ? `'${v}'` : v}`)
    .join(";");
}

export function toHtml(text: string): string {
  const html = parse(text)
    .map((r) => {
      const t = esc(r.text).replace(/\n/g, "<br>");
      const css = cssText(r);
      return css ? `<span style="${css}">${t}</span>` : t;
    })
    .join("");
  return text.endsWith("\n") ? `${html}<br>` : html; // a trailing line break needs a second <br> to show
}

function toHex(c: string): string | undefined {
  if (!c) return undefined;
  if (HEX.test(c)) return c.toLowerCase();
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(c);
  if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return undefined;
  return `#${[m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, "0")).join("")}`;
}

/** execCommand's keyword sizes (seen only while a size is being applied) → points. */
const KEYWORD_PT: Record<string, number> = { "x-small": 10, small: 13, medium: 16, large: 18, "x-large": 24, "xx-large": 32 };

function sizeOf(v: string): number | undefined {
  if (!v) return undefined;
  const calc = /\*\s*([\d.]+)\)/.exec(v);
  if (calc) return Number(calc[1]);
  const pt = /^([\d.]+)pt$/.exec(v);
  if (pt) return Number(pt[1]);
  const px = /^([\d.]+)px$/.exec(v);
  if (px) return Math.round(Number(px[1]) * 0.75 * 2) / 2;
  return KEYWORD_PT[v];
}

function fontOf(v: string): string | undefined {
  const first = v.split(",")[0]?.replace(/["']/g, "").trim().toLowerCase();
  return (FONTS as readonly string[]).find((f) => f.toLowerCase() === first);
}

type Ctx = Omit<Run, "text">;

function collect(node: Node, ctx: Ctx, out: Run[]) {
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      out.push({ text: (child.textContent ?? "").replace(/ /g, " "), ...ctx });
      return;
    }
    if (!(child instanceof HTMLElement)) return;
    const tag = child.tagName;
    if (tag === "BR") {
      out.push({ text: "\n", ...ctx });
      return;
    }
    if ((tag === "DIV" || tag === "P") && out.length && !out[out.length - 1].text.endsWith("\n")) out.push({ text: "\n", ...ctx });
    const css = child.style;
    const deco = `${css.textDecorationLine} ${css.textDecoration}`;
    const next: Ctx = {
      b: ctx.b || tag === "B" || tag === "STRONG" || css.fontWeight === "bold" || Number(css.fontWeight) >= 600,
      i: ctx.i || tag === "I" || tag === "EM" || css.fontStyle === "italic",
      u: ctx.u || tag === "U" || deco.includes("underline"),
      s: ctx.s || tag === "S" || tag === "STRIKE" || tag === "DEL" || deco.includes("line-through"),
      font: fontOf(css.fontFamily || child.getAttribute("face") || "") ?? ctx.font,
      size: sizeOf(css.fontSize) ?? ctx.size,
      color: toHex(css.color || child.getAttribute("color") || "") ?? ctx.color,
      bg: toHex(css.backgroundColor) ?? ctx.bg,
    };
    // An explicit "normal" switches inherited emphasis off (that is how execCommand toggles off).
    if (css.fontWeight === "normal" || css.fontWeight === "400") next.b = false;
    if (css.fontStyle === "normal") next.i = false;
    if (/\bnone\b/.test(deco)) {
      next.u = false;
      next.s = false;
    }
    collect(child, next, out);
  });
}

export function domToMarked(node: Node): string {
  const out: Run[] = [];
  collect(node, { b: false, i: false, u: false, s: false }, out);
  const merged: Run[] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && sameStyle(last, r)) last.text += r.text;
    else merged.push({ ...r });
  }
  return serialize(merged).replace(/\n$/, "");
}

// ── Selection, formatting commands, toolbar state ───────────────────────────

let saved: { el: HTMLElement; range: Range } | null = null;

function richOf(node: Node | null): HTMLElement | null {
  let n: Node | null = node;
  while (n && !(n instanceof HTMLElement && n.dataset.rich === "true")) n = n.parentNode;
  return n as HTMLElement | null;
}

if (typeof document !== "undefined") {
  // Toolbar buttons and dropdowns take focus away; remember where the user's selection was.
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const el = richOf(sel.anchorNode);
    if (el) saved = { el, range: sel.getRangeAt(0).cloneRange() };
  });
}

/** True when the user has text selected inside an editor (so formats apply to that text, not the block). */
export function hasTextSelection(): boolean {
  return !!saved && document.contains(saved.el) && !saved.range.collapsed;
}

export type InlineCommand =
  | { kind: "toggle"; mark: Toggle }
  | { kind: "font"; value: string }
  | { kind: "size"; value: number }
  | { kind: "color"; value: string }
  | { kind: "bg"; value: string }
  | { kind: "clear" };

/** Apply a format to the selected text. Returns false when no text is selected (then format the block). */
export function formatSelection(cmd: InlineCommand): boolean {
  if (!saved || saved.range.collapsed || !document.contains(saved.el)) return false;
  const el = saved.el;
  el.focus({ preventScroll: true });
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(saved.range);
  document.execCommand("styleWithCSS", false, "true");
  switch (cmd.kind) {
    case "toggle":
      document.execCommand({ b: "bold", i: "italic", u: "underline", s: "strikeThrough" }[cmd.mark]);
      break;
    case "font":
      document.execCommand("fontName", false, cmd.value);
      break;
    case "color":
      document.execCommand("foreColor", false, cmd.value);
      break;
    case "bg":
      document.execCommand("hiliteColor", false, cmd.value || "transparent");
      break;
    case "clear":
      document.execCommand("removeFormat");
      break;
    case "size":
      // Mark the selection with a keyword size, then swap the keyword for the exact point size.
      document.execCommand("fontSize", false, "7");
      el.querySelectorAll<HTMLElement>("[style*='xxx-large'], font[size='7']").forEach((n) => {
        n.removeAttribute("size");
        n.style.fontSize = ptSize(cmd.value);
      });
      break;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  const after = window.getSelection();
  if (after && after.rangeCount) saved = { el, range: after.getRangeAt(0).cloneRange() };
  return true;
}

export interface FormatState {
  b: boolean;
  i: boolean;
  u: boolean;
  s: boolean;
}

/** Which toggles apply at the caret (for the toolbar's pressed state). */
export function useFormatState(): FormatState {
  const [st, setSt] = useState<FormatState>({ b: false, i: false, u: false, s: false });
  useEffect(() => {
    const update = () => {
      const sel = window.getSelection();
      const inText = !!sel && !!richOf(sel.anchorNode);
      const q = (c: string) => {
        try {
          return inText && document.queryCommandState(c);
        } catch {
          return false;
        }
      };
      setSt({ b: q("bold"), i: q("italic"), u: q("underline"), s: q("strikeThrough") });
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);
  return st;
}

// ── The editable element ────────────────────────────────────────────────────

function caretAtStart(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return false;
  const range = sel.getRangeAt(0);
  if (!range.collapsed || !el.contains(range.startContainer)) return false;
  const probe = document.createRange();
  probe.selectNodeContents(el);
  probe.setEnd(range.startContainer, range.startOffset);
  return !probe.toString();
}

export interface RichProps {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  style?: CSSProperties;
  placeholder?: string;
  /** One line: Enter finishes (or calls onEnter). */
  single?: boolean;
  onEnter?: () => void;
  onBackspaceEmpty?: () => void;
  autoFocus?: boolean;
  label?: string;
}

export function RichText({
  value,
  onChange,
  className,
  style,
  placeholder = "Click to type",
  single = false,
  onEnter,
  onBackspaceEmpty,
  autoFocus = false,
  label,
}: RichProps) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = useRef<string | null>(null); // what this element last produced; anything else came from outside

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || shown.current === value) return;
    el.innerHTML = toHtml(value);
    shown.current = value;
  }, [value]);

  useEffect(() => {
    const el = ref.current;
    if (!autoFocus || !el) return;
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(r);
  }, [autoFocus]);

  const emit = () => {
    const el = ref.current;
    if (!el) return;
    let v = domToMarked(el);
    if (single) v = v.replace(/\n/g, " ");
    if (!v && el.innerHTML) el.innerHTML = ""; // a lone <br> would hide the placeholder
    shown.current = v;
    onChange(v);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey && !e.shiftKey && (key === "b" || key === "i" || key === "u")) {
      e.preventDefault();
      formatSelection({ kind: "toggle", mark: key as Toggle });
      return;
    }
    if (mod && e.shiftKey && key === "x") {
      e.preventDefault();
      formatSelection({ kind: "toggle", mark: "s" });
      return;
    }
    if (e.key === "Escape") {
      e.currentTarget.blur();
      return;
    }
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (single || (onEnter && !e.shiftKey)) {
        e.currentTarget.blur();
        onEnter?.();
        return;
      }
      document.execCommand("insertLineBreak");
      emit();
      return;
    }
    if (e.key === "Backspace" && onBackspaceEmpty && !value && caretAtStart(e.currentTarget)) {
      e.preventDefault();
      onBackspaceEmpty();
    }
  };

  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline={!single}
      aria-label={label ?? placeholder}
      data-rich="true"
      data-placeholder={placeholder}
      spellCheck
      onInput={emit}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      onPaste={(e) => {
        // Text arrives without outside formatting (no foreign HTML ever reaches the document).
        e.preventDefault();
        document.execCommand("insertText", false, e.clipboardData.getData("text/plain").replace(/\r/g, ""));
      }}
      style={style}
      className={cx(
        className,
        "min-h-[1.2em] cursor-text whitespace-pre-wrap break-words rounded-[2px] outline-none",
        "hover:outline hover:outline-1 hover:outline-signal/30 focus:outline focus:outline-1 focus:outline-signal/60",
        "empty:before:pointer-events-none empty:before:opacity-40 empty:before:content-[attr(data-placeholder)]",
      )}
    />
  );
}
