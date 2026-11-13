"use client";

// Log in and Sign up: one form, two modes. The left half is the ring (the page's one motif) on the accent field.

import Link from "next/link";
import { useEffect, useState } from "react";
import { Ring } from "@/components/landing/Ring";

type Mode = "login" | "signup";

/** Only same-site paths may be returned to after signing in (no open redirects). */
function safeNext(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/app";
}

const field =
  "mt-2 block w-full border-2 border-ink/80 bg-white px-4 py-3 text-[16px] text-ink outline-none transition-colors placeholder:text-mute focus:border-signal";

export function AuthForm({ mode }: { mode: Mode }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [next, setNext] = useState("/app");

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setNext(safeNext(q.get("next")));
    if (q.get("email")) setEmail(q.get("email")!.slice(0, 200));
    if (q.get("name")) setName(q.get("name")!.slice(0, 80));
    // Already signed in: straight to the workspace.
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.user && window.location.replace(safeNext(q.get("next"))))
      .catch(() => {});
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "signup" ? { email, password, name } : { email, password }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok)
        throw new Error(
          typeof body.detail === "string"
            ? body.detail
            : r.status >= 500
              ? "The server isn't answering. Try again in a moment."
              : "That didn't work. Try again.",
        );
      window.location.href = next;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const signup = mode === "signup";
  return (
    <main className="grid min-h-[100svh] bg-paper lg:grid-cols-2">
      <section className="relative hidden overflow-hidden bg-signal text-white lg:block" aria-hidden="true">
        <Ring className="absolute -bottom-[62vh] -left-[34vh] h-[110vh] w-[110vh] text-ink/90" />
        <Link href="/" className="absolute left-12 top-10 font-serif text-[26px] text-white" tabIndex={-1}>
          Ouroboros
        </Link>
        <p className="absolute left-12 top-[22%] max-w-[340px] font-serif text-[34px] leading-[1.12] text-white">
          {signup ? "One brief in. The whole loop runs, and runs again." : "Your desk is where you left it."}
        </p>
      </section>

      <section className="flex flex-col px-5 py-8 sm:px-10 lg:px-20 lg:py-10">
        <div className="flex items-center justify-between">
          <Link href="/" className="font-serif text-[24px] text-ink lg:invisible">
            Ouroboros
          </Link>
          <Link href={signup ? "/login" : "/signup"} className="text-[15px] text-ink underline-offset-4 hover:text-signal hover:underline">
            {signup ? "Log in" : "Create an account"}
          </Link>
        </div>

        <div className="my-auto w-full max-w-[420px] py-12">
          <h1 className="font-serif text-[44px] leading-[1.02] text-ink sm:text-[52px]">{signup ? "Start free" : "Log in"}</h1>
          <p className="mt-4 text-[16px] leading-relaxed text-graphite">
            {signup
              ? "1,000 credits to start: enough for a full analysis and twenty questions. No card needed."
              : "Pick up your analyses, boards, chats and agent tasks."}
          </p>

          <form onSubmit={submit} className="mt-9 space-y-5" noValidate>
            {signup && (
              <label className="block text-[15px] font-medium text-ink">
                Your name
                <input className={field} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} placeholder="Dewi Lestari" />
              </label>
            )}
            <label className="block text-[15px] font-medium text-ink">
              Email
              <input
                className={field}
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                inputMode="email"
                placeholder="you@company.com"
              />
            </label>
            <div>
              <label htmlFor="password" className="block text-[15px] font-medium text-ink">
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  className={`${field} pr-20`}
                  type={show ? "text" : "password"}
                  required
                  minLength={signup ? 8 : undefined}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={signup ? "new-password" : "current-password"}
                  aria-describedby={signup ? "pw-rule" : undefined}
                />
                <button
                  type="button"
                  onClick={() => setShow((s) => !s)}
                  className="absolute right-3 top-1/2 mt-1 -translate-y-1/2 px-2 py-1 text-[13px] font-medium text-graphite hover:text-ink"
                  aria-pressed={show}
                >
                  {show ? "Hide" : "Show"}
                </button>
              </div>
              {signup && (
                <p id="pw-rule" className="mt-2 text-[13px] text-graphite">
                  At least 8 characters.
                </p>
              )}
            </div>

            {error && (
              <p role="alert" className="bg-signal/10 px-4 py-3 text-[14px] text-ink">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy || !email || !password}
              className="w-full rounded-full bg-ink px-6 py-4 text-[16px] font-medium text-paper transition-[background-color,transform] hover:bg-signal active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (signup ? "Creating your desk…" : "Logging in…") : signup ? "Create my account" : "Log in"}
            </button>
          </form>

          <p className="mt-6 text-[14px] text-graphite">
            {signup ? "Already have an account? " : "New to Ouroboros? "}
            <Link
              href={signup ? `/login${next !== "/app" ? `?next=${encodeURIComponent(next)}` : ""}` : "/signup"}
              className="font-medium text-ink underline underline-offset-4 hover:text-signal"
            >
              {signup ? "Log in" : "Start free"}
            </Link>
          </p>
        </div>
      </section>
    </main>
  );
}
