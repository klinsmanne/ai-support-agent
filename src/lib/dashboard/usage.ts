import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Free-tier usage vs limits. Usage is global (not tenant data), read with the service client by
 * the server after the viewer is authenticated. Limits are conservative *estimates*: Gemini no
 * longer publishes free-tier numbers (they're per project in AI Studio), Groq's are from its docs.
 * Sources: docs/research/FREE_TIER_RESEARCH.md. Warnings start at 80%.
 */
export const DAILY_LIMITS: {
  key: string;
  label: string;
  metric: string;
  provider: string;
  limit: number;
  source: string;
}[] = [
  {
    key: "llm_requests",
    label: "Model calls (all providers)",
    provider: "all",
    metric: "requests",
    limit: 1500,
    source: "estimate: ~250/day × 4 Gemini models + 1,000/day × 2 Groq models, rounded down",
  },
  {
    key: "tokens_in",
    label: "Input tokens",
    provider: "all",
    metric: "tokens_in",
    limit: 2_000_000,
    source: "estimate (Groq 200K TPD/model + Gemini headroom)",
  },
  {
    key: "emails_sent",
    label: "Emails sent (Gmail)",
    provider: "gmail",
    metric: "emails_sent",
    limit: 500,
    source: "Gmail consumer sending limit ~500/day",
  },
];

export const PLATFORM_LIMITS = [
  { label: "Database size", limit: "500 MB", source: "Supabase Free" },
  { label: "Function duration", limit: "300 s max", source: "Vercel Hobby" },
  {
    label: "Gmail API quota",
    limit: "1.2M units/min/project",
    source: "Google (≈2–20 units per poll)",
  },
];

export async function getUsageToday(service: SupabaseClient) {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await service
    .from("usage_daily")
    .select("provider, metric, value")
    .eq("day", today);
  const value = (provider: string, metric: string) =>
    Number((data ?? []).find((r) => r.provider === provider && r.metric === metric)?.value ?? 0);
  return DAILY_LIMITS.map((l) => {
    const used = value(l.provider, l.metric);
    const pct = l.limit ? used / l.limit : 0;
    return { ...l, used, pct, level: pct >= 1 ? "over" : pct >= 0.8 ? "warn" : "ok" };
  });
}
