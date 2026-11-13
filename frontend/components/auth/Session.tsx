"use client";

// Who is signed in (GET /api/auth/me), the gate around the workspace, and the account button in the rail.

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export interface User {
  id: string;
  email: string;
  name: string;
}

const SessionContext = createContext<User | null>(null);
export const useUser = () => useContext(SessionContext);

export async function fetchMe(): Promise<{ user: User | null; required: boolean }> {
  const r = await fetch("/api/auth/me", { cache: "no-store" });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

export async function logOut() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } finally {
    window.location.href = "/";
  }
}

/** Renders the workspace only for a signed-in user; otherwise sends them to the log-in page. */
export function RequireSignIn({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<{ user: User | null; ready: boolean; error: string }>({ user: null, ready: false, error: "" });

  useEffect(() => {
    fetchMe()
      .then(({ user, required }) => {
        if (!user && required) router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
        else setState({ user, ready: true, error: "" });
      })
      .catch(() => setState({ user: null, ready: false, error: "The server isn't answering. Is the backend running on port 8002?" }));
  }, [router]);

  if (!state.ready)
    return (
      <div className="flex min-h-[100svh] items-center justify-center bg-paper px-6 text-[15px] text-graphite">
        {state.error || "Opening your workspace…"}
      </div>
    );
  return <SessionContext.Provider value={state.user}>{children}</SessionContext.Provider>;
}

/** Initials disc at the foot of the app rail; opens a small menu with the account and Log out. */
export function AccountButton() {
  const user = useUser();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (!user) return null;
  const initials = (user.name || user.email)
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

  return (
    <div ref={ref} className="relative ml-auto lg:ml-0 lg:mt-auto">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${user.email}`}
        className="flex h-10 w-10 items-center justify-center rounded-full bg-signal text-[13px] font-semibold text-white transition-transform hover:scale-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-paper lg:mx-auto"
      >
        {initials}
      </button>
      {open && (
        <div
          role="menu"
          // taste-skill-ignore: a real pop-up menu floats above the page
          className={"absolute right-0 top-12 z-50 w-[240px] border border-ink bg-white p-4 shadow-[0_12px_32px_rgba(24,22,19,0.18)] lg:bottom-0 lg:left-14 lg:right-auto lg:top-auto" /* taste-skill-ignore */}
        >
          {user.name && <div className="text-[14px] font-semibold text-ink">{user.name}</div>}
          <div className="truncate text-[13px] text-graphite">{user.email}</div>
          <button
            role="menuitem"
            onClick={logOut}
            className="mt-3 w-full rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-paper transition-colors hover:bg-signal"
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
