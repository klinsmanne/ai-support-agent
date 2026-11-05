"use client";

import { useActionState } from "react";
import { updateSettings, type ActionResult } from "@/app/dashboard/actions";

type Settings = {
  rollout_mode: string;
  kill_switch: boolean;
  refund_auto_approve_limit_cents: number;
  max_refunds_per_customer_30d: number;
  escalate_on_negative_sentiment_below: number;
  min_confidence_to_act: number;
  daily_ticket_cap: number;
  max_ai_replies_per_thread: number;
  /** Only set for owners; viewers get null and see escalation_notify_configured instead. */
  escalation_notify_email: string | null;
  escalation_notify_configured: boolean;
  escalation_digest: boolean;
};

const MODES = [
  {
    value: "shadow",
    label: "Shadow",
    help: "Agent drafts only; nothing is sent. Compare drafts with human replies.",
  },
  {
    value: "draft_only",
    label: "Draft-only",
    help: "A human approves every AI reply before it's sent.",
  },
  {
    value: "auto_send",
    label: "Auto-send",
    help: "AI replies are sent automatically within policy; risky cases still escalate.",
  },
];

export function SettingsForm({
  tenantId,
  settings,
  isOwner,
}: {
  tenantId: string;
  settings: Settings;
  isOwner: boolean;
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    updateSettings,
    null,
  );
  const field =
    "mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950";
  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="tenantId" value={tenantId} />
      <fieldset disabled={!isOwner} className="space-y-6">
        <section className="rounded-xl border border-red-300 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/30">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              name="kill_switch"
              defaultChecked={settings.kill_switch}
              className="mt-1 h-4 w-4"
            />
            <span>
              <span className="font-semibold">Kill switch</span>
              <span className="block text-sm text-zinc-600 dark:text-zinc-400">
                Instantly stops the AI for this company: no model calls, nothing sent. Every new
                message goes to the human queue. Takes effect on the next message, no deploy needed.
              </span>
            </span>
          </label>
        </section>

        <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="mb-3 font-semibold">Rollout mode</h2>
          <div className="grid gap-2 md:grid-cols-3">
            {MODES.map((m) => (
              <label
                key={m.value}
                className="flex gap-2 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800"
              >
                <input
                  type="radio"
                  name="rollout_mode"
                  value={m.value}
                  defaultChecked={settings.rollout_mode === m.value}
                />
                <span>
                  <span className="font-medium">{m.label}</span>
                  <span className="block text-xs text-zinc-500">{m.help}</span>
                </span>
              </label>
            ))}
          </div>
        </section>

        <section className="grid gap-4 rounded-xl border border-zinc-200 bg-white p-4 md:grid-cols-2 dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="font-semibold md:col-span-2">
            Policy limits (enforced in code and in the database)
          </h2>
          <label className="text-sm">
            Auto-approve refunds up to (cents)
            <input
              name="refund_auto_approve_limit_cents"
              type="number"
              min={0}
              max={100000}
              defaultValue={settings.refund_auto_approve_limit_cents}
              className={field}
            />
          </label>
          <label className="text-sm">
            Max refunds per customer / 30 days
            <input
              name="max_refunds_per_customer_30d"
              type="number"
              min={0}
              max={20}
              defaultValue={settings.max_refunds_per_customer_30d}
              className={field}
            />
          </label>
          <label className="text-sm">
            Escalate when sentiment is below (−1 to 0)
            <input
              name="escalate_on_negative_sentiment_below"
              type="number"
              step="0.05"
              min={-1}
              max={0}
              defaultValue={settings.escalate_on_negative_sentiment_below}
              className={field}
            />
          </label>
          <label className="text-sm">
            Minimum confidence to answer policy questions (0–1)
            <input
              name="min_confidence_to_act"
              type="number"
              step="0.05"
              min={0}
              max={1}
              defaultValue={settings.min_confidence_to_act}
              className={field}
            />
          </label>
          <label className="text-sm">
            Daily ticket cap
            <input
              name="daily_ticket_cap"
              type="number"
              min={1}
              max={10000}
              defaultValue={settings.daily_ticket_cap}
              className={field}
            />
          </label>
          <label className="text-sm">
            Max AI replies per conversation
            <input
              name="max_ai_replies_per_thread"
              type="number"
              min={1}
              max={20}
              defaultValue={settings.max_ai_replies_per_thread}
              className={field}
            />
          </label>
        </section>
        <section className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="font-semibold">Notifications</h2>
          <p className="text-xs text-zinc-500">
            Escalations wait in the Escalations queue. Name a team address to get an email right
            away for urgent ones (a customer asks for a person, is very upset, mentions legal or
            safety, a refund is above the limit, or a manipulation attempt), and a daily digest of
            everything still waiting. Emails contain the reason, a summary and a link, never the
            customer&apos;s message.
          </p>
          {isOwner ? (
            <label className="block text-sm">
              Team email for escalations (leave empty to turn off)
              <input
                name="escalation_notify_email"
                type="email"
                placeholder="support-team@client.com"
                defaultValue={settings.escalation_notify_email ?? ""}
                className={field}
              />
            </label>
          ) : (
            <p className="text-sm">
              Team notifications:{" "}
              <strong>{settings.escalation_notify_configured ? "on" : "off"}</strong> (address
              visible to owners only)
            </p>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              name="escalation_digest"
              type="checkbox"
              defaultChecked={settings.escalation_digest}
            />
            Daily digest of waiting escalations (8 am US Central)
          </label>
        </section>
      </fieldset>
      {isOwner ? (
        <button
          disabled={pending}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {pending ? "Saving…" : "Save settings"}
        </button>
      ) : (
        <p className="text-sm text-zinc-500">Read-only: only owners can change settings.</p>
      )}
      {state && (
        <p
          className={`text-sm ${state.ok ? "text-emerald-700 dark:text-emerald-300" : "text-red-600"}`}
          role="status"
        >
          {state.message}
        </p>
      )}
    </form>
  );
}
