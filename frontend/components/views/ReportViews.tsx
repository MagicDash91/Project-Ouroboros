"use client";

import { ArrowDownToLine, ChevronRight } from "../icons";
import { useEffect, useMemo, useState } from "react";
import { formatBytes, getJSON } from "@/lib/api";
import type { BlogSection, ContentItem, ReportFile, Results } from "@/lib/types";
import { Markdown } from "../Markdown";
import { OpenStudio } from "../studio/OpenStudio";
import { useLightbox } from "../Overlays";
import { Empty, SectionHead } from "../ui";

const Page = ({ children }: { children: React.ReactNode }) => <div className="mx-auto max-w-[1080px] px-6 py-10 lg:px-10">{children}</div>;

function DownloadList({ files }: { files: ReportFile[] }) {
  if (!files.length) return null;
  return (
    <ul className="divide-y divide-rule border-y border-ink">
      {files.map((f) => (
        <li key={f.url}>
          <a href={f.url} download className="group flex items-center gap-3 py-2.5 text-[12.5px]">
            <span className="w-9 font-mono text-[10px] uppercase text-signal">{f.ext}</span>
            <span className="min-w-0 flex-1 truncate group-hover:underline" title={f.name}>
              {f.name}
            </span>
            <ArrowDownToLine size={13} className="text-mute group-hover:text-ink" />
          </a>
        </li>
      ))}
    </ul>
  );
}

/* ── Analytics ───────────────────────────────────────────────────────── */
function dedupeSections(sections: BlogSection[]) {
  const seen = new Set<string>();
  return sections.filter((s) => {
    const k = s.chart_url || s.title || "";
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function AnalyticsView({ results }: { results: Results | null }) {
  const lightbox = useLightbox();
  if (!results?.banking_report) {
    return (
      <Page>
        <SectionHead kicker="Stage 3" title="Analytics report" />
        <Empty title="The analysts haven't filed yet.">
          The report appears here once the analytics team finishes. Trained models are already usable from the Model lab.
        </Empty>
      </Page>
    );
  }
  const figures = dedupeSections(results.banking_blog_sections || []);
  const downloads = (results.all_reports || []).filter((r) => r.ext === "pdf" || r.ext === "pptx");

  return (
    <Page>
      <SectionHead kicker="Stage 3 · Analytics team" title="Analytics report" />
      <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_240px]">
        <article className="rise min-w-0 max-w-[68ch]">
          <Markdown>{results.banking_report}</Markdown>
        </article>
        <aside className="space-y-8 lg:sticky lg:top-6 lg:self-start">
          {results.task_id && (
            <OpenStudio
              prefix={`/api/runs/${results.task_id}/studio/analytics`}
              label="Edit this report"
              note="Your run's charts come along. Edit by hand or ask the AI; changes save automatically."
            />
          )}
          {downloads.length > 0 && (
            <div>
              <div className="label mb-2">Take it with you</div>
              <DownloadList files={downloads} />
            </div>
          )}
          {figures.length > 0 && (
            <div>
              <div className="label mb-2">Figures</div>
              <ol className="space-y-1.5 text-[12.5px]">
                {figures.map((f, i) => (
                  <li key={i}>
                    <a href={`#fig-${i + 1}`} className="flex gap-2 text-graphite hover:text-ink">
                      <span className="font-mono text-[11px] text-mute">{i + 1}.</span>
                      <span className="line-clamp-2">{f.title || "Untitled chart"}</span>
                    </a>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </aside>
      </div>

      {figures.length > 0 && (
        <section className="mt-16">
          <div className="mb-8 flex items-baseline gap-4 border-t border-ink pt-4">
            <span className="label text-signal">Figures</span>
            <span className="text-[12px] text-mute">Each chart with the model&apos;s reading of the plotted data</span>
          </div>
          <div className="space-y-16">
            {figures.map((f, i) => {
              const reading = f.gemini_analysis || f.analysis;
              return (
                <figure key={i} id={`fig-${i + 1}`} className="grid scroll-mt-6 gap-8 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
                  <div>
                    {f.chart_url && (
                      <button
                        onClick={() => lightbox(f.chart_url!, f.title)}
                        className="block w-full cursor-zoom-in border border-rule bg-white p-2 transition-colors hover:border-ink"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={f.chart_url} alt={f.title || `Figure ${i + 1}`} loading="lazy" className="w-full" />
                      </button>
                    )}
                    <figcaption className="mt-2 flex gap-2 text-[12.5px]">
                      <span className="font-mono text-signal">Fig. {i + 1}</span>
                      <span className="text-graphite">{f.title}</span>
                    </figcaption>
                  </div>
                  <div className="space-y-6">
                    {reading && (
                      <div>
                        <div className="label mb-2">Reading</div>
                        <Markdown compact>{reading}</Markdown>
                      </div>
                    )}
                    {f.nvidia_recommendations && (
                      <div className="border-l-2 border-signal pl-4">
                        <div className="label mb-2">What to do about it</div>
                        <Markdown compact>{f.nvidia_recommendations}</Markdown>
                      </div>
                    )}
                  </div>
                </figure>
              );
            })}
          </div>
        </section>
      )}
    </Page>
  );
}

/* ── Charts ──────────────────────────────────────────────────────────── */
export function ChartsView({ results }: { results: Results | null }) {
  const lightbox = useLightbox();
  const charts = results?.banking_charts || [];
  return (
    <Page>
      <SectionHead
        kicker="Stage 3"
        title="Chart room"
        aside={charts.length > 0 && <span className="font-mono text-[12px] text-mute">{charts.length} charts</span>}
      />
      {charts.length === 0 ? (
        <Empty title="No charts drawn yet.">The analyst produces these during the analytics stage.</Empty>
      ) : (
        <div className="grid gap-x-6 gap-y-10 sm:grid-cols-2 xl:grid-cols-3">
          {charts.map((c, i) => (
            <figure key={c.url} className="rise" style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}>
              <button
                onClick={() => lightbox(c.url, c.name)}
                className="block aspect-[4/3] w-full cursor-zoom-in overflow-hidden border border-rule bg-white p-1.5 transition-colors hover:border-ink"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={c.url} alt={c.name} loading="lazy" className="h-full w-full object-contain" />
              </button>
              <figcaption className="mt-2 flex gap-2 text-[12px]">
                <span className="font-mono text-signal">{String(i + 1).padStart(2, "0")}</span>
                <span className="truncate text-graphite" title={c.name}>
                  {c.name.replace(/\.png$/i, "").replace(/[_-]+/g, " ")}
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </Page>
  );
}

/* ── Marketing ───────────────────────────────────────────────────────── */
export function MarketingView({ results }: { results: Results | null }) {
  const report = results?.marketing_report || "";
  const brief = results?.campaign_brief || "";
  if (!report && !brief) {
    return (
      <Page>
        <SectionHead kicker="Stage 4" title="Campaign brief" />
        <Empty title="Marketing hasn't picked this up yet.">
          The marketing team starts from the analysts&apos; findings, so this fills in after the analytics stage.
        </Empty>
      </Page>
    );
  }
  const downloads = (results?.all_reports || []).filter((r) => /marketing|campaign/i.test(r.name));
  return (
    <Page>
      <SectionHead kicker="Stage 4 · Marketing team" title="Campaign brief" />
      <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_240px]">
        <div className="min-w-0 max-w-[68ch] space-y-12">
          {brief && (
            <section className="rise border border-ink bg-sheet p-6">
              <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2 border-b border-rule pb-3">
                <span className="label text-signal">Memo · CDO to marketing</span>
                <span className="text-[11.5px] italic text-mute">written from the analysts&apos; findings</span>
              </div>
              <Markdown compact>{brief}</Markdown>
            </section>
          )}
          {report && (
            <article className="rise">
              <Markdown>{report}</Markdown>
            </article>
          )}
        </div>
        <aside className="space-y-8 lg:sticky lg:top-6 lg:self-start">
          {(report || brief) && results?.task_id && <OpenStudio prefix={`/api/runs/${results.task_id}/studio/marketing`} label="Edit this campaign" />}
          {downloads.length > 0 && (
            <div>
              <div className="label mb-2">Take it with you</div>
              <DownloadList files={downloads} />
            </div>
          )}
        </aside>
      </div>
    </Page>
  );
}

/* ── Content ─────────────────────────────────────────────────────────── */
function socialPosts(item: ContentItem): { text: string; tags: string[] }[] {
  try {
    const parsed = JSON.parse(item.content || "");
    if (Array.isArray(parsed)) {
      return parsed.slice(0, 3).map((p) => ({ text: String(p.post || ""), tags: Array.isArray(p.hashtags) ? p.hashtags : [] }));
    }
  } catch {
    /* plain text */
  }
  return [{ text: String(item.content || "").slice(0, 420), tags: [] }];
}

export function ContentView({ results }: { results: Results | null }) {
  const lightbox = useLightbox();
  const items = results?.marketing_content_items || [];
  const posters = items.filter((i) => i.type === "poster" && i.poster_url);
  const posts = items.filter((i) => i.type === "social_post");
  const ads = items.filter((i) => i.type === "ad_copy");

  return (
    <Page>
      <SectionHead kicker="Stage 4" title="Content" />
      {items.length === 0 ? (
        <Empty title="Nothing to publish yet.">Posters, social posts and ad copy appear after the marketing stage.</Empty>
      ) : (
        <div className="space-y-16">
          {posters.length > 0 && (
            <section>
              <div className="label mb-4">Posters · {posters.length}</div>
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {posters.map((p, i) => (
                  <figure key={i}>
                    <button
                      onClick={() => lightbox(p.poster_url!, p.title)}
                      className="block w-full cursor-zoom-in border border-rule bg-white p-1.5 hover:border-ink"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.poster_url} alt={p.title || "Poster"} loading="lazy" className="aspect-square w-full object-cover" />
                    </button>
                    <figcaption className="mt-2 text-[12.5px] text-graphite">{p.title || "Promotional poster"}</figcaption>
                  </figure>
                ))}
              </div>
            </section>
          )}

          {posts.length > 0 && (
            <section>
              <div className="label mb-4">Social posts · {posts.length}</div>
              <div className="columns-1 gap-6 md:columns-2 xl:columns-3">
                {posts.map((p, i) => (
                  <article key={i} className="mb-6 break-inside-avoid border-t-2 border-ink bg-sheet px-5 pb-5 pt-3">
                    <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.1em] text-signal">{p.platform || "Social"}</div>
                    {socialPosts(p).map((post, j) => (
                      <div key={j} className={j > 0 ? "mt-4 border-t border-rule pt-4" : ""}>
                        <p className="whitespace-pre-wrap font-serif text-[15.5px] leading-relaxed">{post.text}</p>
                        {post.tags.length > 0 && (
                          <p className="mt-2 text-[12px] text-moss">{post.tags.map((t) => `#${String(t).replace(/^#/, "")}`).join(" ")}</p>
                        )}
                      </div>
                    ))}
                  </article>
                ))}
              </div>
            </section>
          )}

          {ads.length > 0 && (
            <section>
              <div className="label mb-4">Ad copy · {ads.length}</div>
              <div className="divide-y divide-rule border-y border-ink">
                {ads.map((ad, i) => (
                  <details key={i} className="group">
                    <summary className="flex cursor-pointer list-none items-center gap-3 py-3.5">
                      <ChevronRight size={14} className="text-mute transition-transform group-open:rotate-90" />
                      <span className="flex-1 text-[14px]">{ad.title || ad.platform || "Ad copy"}</span>
                      {ad.platform && <span className="font-mono text-[11px] uppercase text-mute">{ad.platform}</span>}
                    </summary>
                    <div className="pb-6 pl-7">
                      <Markdown compact>{ad.content || ""}</Markdown>
                    </div>
                  </details>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </Page>
  );
}

/* ── Files ───────────────────────────────────────────────────────────── */
export function FilesView({ results }: { results: Results | null }) {
  const [fallback, setFallback] = useState<ReportFile[]>([]);
  const own = useMemo(() => results?.all_reports || [], [results]);

  // Before any run in this session, list whatever reports already exist on disk.
  useEffect(() => {
    if (own.length) return;
    getJSON<{ reports: ReportFile[] }>("/api/reports")
      .then((r) => setFallback(r.reports || []))
      .catch(() => undefined);
  }, [own.length]);

  const files = own.length ? own : fallback;
  return (
    <Page>
      <SectionHead
        kicker="Archive"
        title="Files"
        aside={!own.length && fallback.length > 0 && <span className="text-[12px] italic text-mute">from earlier runs</span>}
      />
      {files.length === 0 ? (
        <Empty title="No files on record.">PDF, PowerPoint and Markdown reports land here when a run finishes.</Empty>
      ) : (
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b-[1.5px] border-ink text-left">
              <th className="label py-2 pr-4 font-semibold">Type</th>
              <th className="label py-2 pr-4 font-semibold">Name</th>
              <th className="label py-2 pr-4 text-right font-semibold">Size</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.url} className="border-b border-rule">
                <td className="py-3 pr-4 font-mono text-[11px] uppercase text-signal">{f.ext}</td>
                <td className="max-w-0 truncate py-3 pr-4" title={f.name}>
                  {f.name}
                </td>
                <td className="whitespace-nowrap py-3 pr-4 text-right font-mono text-[12px] text-mute">{formatBytes(f.size)}</td>
                <td className="py-3 text-right">
                  <a href={f.url} download className="inline-flex items-center gap-1.5 text-[12.5px] font-medium hover:text-signal">
                    Download <ArrowDownToLine size={13} />
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}
