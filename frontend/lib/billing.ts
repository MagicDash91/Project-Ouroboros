"use client";

import { useCallback, useEffect, useState } from "react";
import { getJSON } from "./api";

/* Mirrors pricing.json (the single source of prices) and features/billing.py summary(). */

export interface ActionPrice {
  credits: number;
  label: string;
  detail: string;
  included_searches?: number;
}

export interface Plan {
  id: string;
  name: string;
  tagline: string;
  usd_month: number | null;
  idr_month: number | null;
  usd_year: number | null;
  idr_year: number | null;
  credits_month: number | null;
  signup_credits?: number;
  equals: string;
  seats: string;
  schedules: string;
  concurrent: string;
  upload_mb: string;
  db_connections: string;
  airflow: boolean;
  shared_workspace: boolean;
  enterprise: boolean;
  spend_cap_usd: number | null;
  popular?: boolean;
  contact?: boolean;
}

export interface Pack {
  id: string;
  name: string;
  credits: number;
  usd: number;
  idr: number;
  popular?: boolean;
}

export interface Pricing {
  version: string;
  credit_value_usd: number;
  credit_value_idr: number;
  actions: Record<string, ActionPrice>;
  free_actions: string[];
  plans: Plan[];
  packs: Pack[];
  rules: { rollover_pct_of_allowance: number; spend_order: string[]; auto_topup_below: number };
}

export interface LedgerEntry {
  id: string;
  ts: string;
  kind: "grant" | "charge" | "refund" | "refund_grant" | "topup" | "subscribe" | "expire" | "migrate";
  action?: string;
  credits: number;
  note: string;
  bucket?: string;
}

export interface Billing {
  balance: number;
  buckets: Record<string, { credits: number; expires_at: string | null }>;
  plan: { id: string; name: string; interval: "month" | "year"; period_start: string; period_end: string };
  used_this_period: number;
  settings: { spend_cap_usd: number | null; auto_topup: boolean };
  enforced: boolean;
  demo_checkout: boolean;
  pricing: Pricing;
  ledger: LedgerEntry[];
}

/** Wallet state, refreshed on an interval and on window focus (work is refunded in the background). */
export function useBilling(intervalMs = 10_000) {
  const [billing, setBillingState] = useState<Billing | null>(null);
  const [error, setError] = useState("");

  const setBilling = useCallback((b: Billing) => {
    setBillingState(b);
    setError("");
  }, []);

  const refresh = useCallback(() => {
    getJSON<Billing>("/api/billing")
      .then(setBilling)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [setBilling]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, intervalMs);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh, intervalMs]);

  return { billing, error, setBilling, refresh };
}

export const fmtCredits = (n: number) => Math.round(n).toLocaleString("en-US");
/** Compact balance for the rail: 950 · 7.3k · 35k */
export const fmtCreditsShort = (n: number) =>
  n < 1000 ? String(Math.round(n)) : n < 10_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : `${Math.round(n / 1000)}k`;
export const fmtUsd = (usd: number) =>
  `$${usd.toLocaleString("en-US", { minimumFractionDigits: usd % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
export const fmtIdr = (idr: number) => `Rp ${idr.toLocaleString("id-ID")}`;
