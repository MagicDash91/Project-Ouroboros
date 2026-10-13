"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { del, errorText, getJSON, postForm, postJSON } from "@/lib/api";
import { Button, cx } from "../ui";

/* Brand kits (features/brand.py): colours, fonts, logo and footer for decks and documents.
   On screen a kit is applied by overriding the theme's CSS variables on the slide / page. */

export interface BrandKit {
  id: string;
  name: string;
  accent: string;
  dark: string;
  background: string;
  text: string;
  heading_font: string;
  body_font: string;
  logo: string;
  footer: string;
  default: boolean;
  builtin?: boolean;
}

const hexToRgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a: number[], b: number[], t: number) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
const v = (c: number[]) => c.join(" ");

/** CSS variables that make every themed class inside an element use the kit. `dark` = a title slide. */
export function brandVars(kit: BrandKit | undefined, dark = false): CSSProperties {
  if (!kit || !/^#[0-9a-f]{6}$/i.test(kit.text || "")) return {};
  const text = hexToRgb(kit.text),
    bg = hexToRgb(kit.background),
    dk = hexToRgb(kit.dark);
  return {
    "--ink": v(dark ? dk : text),
    "--paper": v(bg),
    "--sheet": v(mix(bg, [255, 255, 255], 0.5)),
    "--signal": v(hexToRgb(kit.accent)),
    "--graphite": v(mix(text, bg, 0.25)),
    "--mute": v(mix(text, bg, 0.5)),
    "--rule": v(mix(text, bg, 0.8)),
    "--font-serif": `"${kit.heading_font}", Georgia, serif`,
    "--font-sans": `"${kit.body_font}", system-ui, sans-serif`,
  } as CSSProperties;
}

export function useBrandKits() {
  const [kits, setKits] = useState<BrandKit[]>([]);
  const [fonts, setFonts] = useState<string[]>([]);
  const reload = useCallback(
    () =>
      getJSON<{ kits: BrandKit[]; fonts: string[] }>("/api/brand/kits")
        .then((r) => {
          setKits(r.kits);
          setFonts(r.fonts);
        })
        .catch(() => undefined),
    [],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  /** The kit for a deck / document ("" = the default kit). */
  const pick = (id?: string) => kits.find((k) => k.id === id) ?? kits.find((k) => k.default) ?? kits[0];
  return { kits, fonts, reload, pick };
}

const BLANK: Partial<BrandKit> = {
  name: "",
  accent: "#0057b8",
  dark: "#0b2545",
  background: "#ffffff",
  text: "#13315c",
  heading_font: "Georgia",
  body_font: "Calibri",
  footer: "",
};

/** Top-bar control: choose the kit for this deck / document, or manage kits. */
export function BrandMenu({
  current,
  kits,
  fonts,
  onPick,
  reload,
}: {
  current?: BrandKit;
  kits: BrandKit[];
  fonts: string[];
  onPick: (id: string) => void;
  reload: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  return (
    <div className="relative">
      <Button size="sm" tone="quiet" onClick={() => setOpen((o) => !o)}>
        <span className="inline-block h-3 w-3 rounded-full ring-1 ring-ink/20" style={{ background: current?.accent }} />
        Brand
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-9 z-20 w-[260px] border border-ink bg-white p-2 shadow-lg">
            <div className="label mb-1.5 px-1">Brand kit</div>
            <ul>
              {kits.map((k) => (
                <li key={k.id}>
                  <button
                    onClick={() => {
                      onPick(k.id);
                      setOpen(false);
                    }}
                    className={cx(
                      "flex w-full items-center gap-2 px-1.5 py-1.5 text-left text-[12.5px] hover:bg-ink/5",
                      current?.id === k.id && "font-medium",
                    )}
                  >
                    <span className="flex">
                      {[k.dark, k.accent, k.background].map((c, i) => (
                        <span key={i} className="h-3.5 w-3.5 ring-1 ring-ink/15" style={{ background: c }} />
                      ))}
                    </span>
                    <span className="flex-1 truncate">{k.name}</span>
                    {k.default && <span className="font-mono text-[9.5px] uppercase text-mute">default</span>}
                    {current?.id === k.id && <span className="text-moss">✓</span>}
                  </button>
                </li>
              ))}
            </ul>
            <button
              onClick={() => {
                setOpen(false);
                setManaging(true);
              }}
              className="mt-1 w-full border-t border-rule px-1.5 pt-2 text-left text-[12px] text-graphite hover:text-signal"
            >
              Manage brand kits…
            </button>
          </div>
        </>
      )}
      {managing && <BrandKitsDialog kits={kits} fonts={fonts} reload={reload} onClose={() => setManaging(false)} />}
    </div>
  );
}

function BrandKitsDialog({
  kits,
  fonts,
  reload,
  onClose,
}: {
  kits: BrandKit[];
  fonts: string[];
  reload: () => Promise<void> | void;
  onClose: () => void;
}) {
  const editable = kits.filter((k) => !k.builtin);
  const [form, setForm] = useState<Partial<BrandKit> | null>(editable[0] ?? null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof BrandKit, val: string | boolean) => setForm((f) => ({ ...(f ?? {}), [k]: val }));

  async function save() {
    if (!form) return;
    setBusy(true);
    setError("");
    try {
      const saved = await postJSON<BrandKit>("/api/brand/kits", form);
      await reload();
      setForm(saved);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File) {
    if (!form?.id) {
      setError("Save the kit first, then add the logo.");
      return;
    }
    const fd = new FormData();
    fd.append("file", file);
    try {
      const saved = await postForm<BrandKit>(`/api/brand/kits/${form.id}/logo`, fd);
      await reload();
      setForm(saved);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function remove() {
    if (!form?.id || !window.confirm(`Delete the brand kit “${form.name}”?`)) return;
    await del(`/api/brand/kits/${form.id}`).catch(() => undefined);
    await reload();
    setForm(null);
  }

  const field = "w-full border border-rule bg-white px-2 py-1.5 text-[12.5px] focus:border-ink focus:outline-none";
  const preview = form?.accent ? (form as BrandKit) : undefined;
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-night/50 p-4" onClick={onClose}>
      <div
        className="grid max-h-[90vh] w-full max-w-[860px] grid-cols-[200px_minmax(0,1fr)] overflow-hidden border border-ink bg-paper"
        onClick={(e) => e.stopPropagation()}
      >
        <aside className="overflow-y-auto border-r border-rule bg-sheet p-3">
          <div className="label mb-2">Brand kits</div>
          <ul className="space-y-0.5">
            {editable.map((k) => (
              <li key={k.id}>
                <button
                  onClick={() => setForm(k)}
                  className={cx(
                    "w-full truncate px-2 py-1.5 text-left text-[12.5px]",
                    form?.id === k.id ? "bg-ink text-paper" : "hover:bg-ink/5",
                  )}
                >
                  {k.name}
                </button>
              </li>
            ))}
          </ul>
          <Button size="sm" tone="line" className="mt-3 w-full" onClick={() => setForm({ ...BLANK })}>
            + New kit
          </Button>
          <p className="mt-3 text-[11px] leading-snug text-mute">The built-in Ouroboros style is always available.</p>
        </aside>
        <div className="overflow-y-auto p-5">
          {!form ? (
            <p className="text-[13px] text-mute">Create a kit with your company&apos;s colours, fonts and logo.</p>
          ) : (
            <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_260px]">
              <div className="space-y-3">
                <label className="block">
                  <span className="label mb-1 block">Name</span>
                  <input
                    value={form.name ?? ""}
                    onChange={(e) => set("name", e.target.value)}
                    placeholder="e.g. Bank Biru"
                    className={field}
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ["accent", "Accent"],
                      ["dark", "Dark (title slides)"],
                      ["background", "Background"],
                      ["text", "Text"],
                    ] as const
                  ).map(([k, label]) => (
                    <label key={k} className="block">
                      <span className="label mb-1 block">{label}</span>
                      <span className="flex items-center gap-2">
                        <input
                          type="color"
                          value={(form[k] as string) || "#000000"}
                          onChange={(e) => set(k, e.target.value)}
                          className="h-8 w-10 cursor-pointer border border-rule bg-white"
                        />
                        <input
                          value={(form[k] as string) ?? ""}
                          onChange={(e) => set(k, e.target.value)}
                          className={cx(field, "font-mono")}
                        />
                      </span>
                    </label>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ["heading_font", "Heading font"],
                      ["body_font", "Body font"],
                    ] as const
                  ).map(([k, label]) => (
                    <label key={k} className="block">
                      <span className="label mb-1 block">{label}</span>
                      <select
                        value={(form[k] as string) ?? ""}
                        onChange={(e) => set(k, e.target.value)}
                        className={field}
                        style={{ fontFamily: form[k] as string }}
                      >
                        {fonts.map((f) => (
                          <option key={f} value={f} style={{ fontFamily: f }}>
                            {f}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
                <label className="block">
                  <span className="label mb-1 block">Footer text (optional)</span>
                  <input
                    value={form.footer ?? ""}
                    onChange={(e) => set("footer", e.target.value)}
                    placeholder="e.g. Bank Biru · Internal"
                    className={field}
                  />
                </label>
                <label className="block">
                  <span className="label mb-1 block">Logo (PNG or JPG, under 2 MB)</span>
                  <input
                    type="file"
                    accept=".png,.jpg,.jpeg"
                    onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])}
                    className="text-[12px]"
                  />
                </label>
                <label className="flex items-center gap-2 text-[12.5px]">
                  <input
                    type="checkbox"
                    checked={!!form.default}
                    onChange={(e) => set("default", e.target.checked)}
                    className="accent-signal"
                  />
                  Use for new decks and documents
                </label>
                {error && <p className="text-[12px] text-signal">{error}</p>}
                <div className="flex gap-2">
                  <Button size="sm" tone="ink" onClick={save} disabled={busy}>
                    {busy ? "Saving…" : "Save kit"}
                  </Button>
                  {form.id && (
                    <Button size="sm" tone="quiet" onClick={remove}>
                      Delete
                    </Button>
                  )}
                  <Button size="sm" tone="quiet" className="ml-auto" onClick={onClose}>
                    Close
                  </Button>
                </div>
              </div>
              <div>
                <div className="label mb-1.5">Preview</div>
                {preview && (
                  <div style={{ containerType: "inline-size" }} className="space-y-2">
                    <div style={brandVars(preview, true)} className="aspect-[16/9] bg-ink p-[6cqw] text-paper">
                      {preview.logo && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={preview.logo} alt="" className="mb-[3cqw] h-[9cqw] w-auto" />
                      )}
                      <div className="flex gap-[3cqw]">
                        <span className="w-[1.4cqw] bg-signal" />
                        <span className="font-serif text-[8cqw] leading-tight">Quarterly review</span>
                      </div>
                    </div>
                    <div style={brandVars(preview)} className="aspect-[16/9] bg-paper p-[6cqw] text-ink">
                      <div className="border-b border-ink pb-[2cqw] font-serif text-[7cqw]">Key findings</div>
                      <p className="mt-[3cqw] font-sans text-[4.5cqw]">
                        <span className="text-signal">— </span>Revenue grew <strong>18%</strong>
                      </p>
                      <p className="mt-[3cqw] font-sans text-[3.5cqw] text-mute">{preview.footer}</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
