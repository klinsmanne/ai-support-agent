import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentResult } from "../agent/orchestrator.ts";
import type { ChannelId } from "../channels/types.ts";
import { maskDeep, maskPII } from "../guardrails/pii.ts";
import type { TenantSettings } from "../tenants/config.ts";
import { estimateCostUsd } from "../llm/pricing.ts";
import type { MessageStatus, PipelineStore, TicketRef } from "./store.ts";

/** Supabase implementation. Service-role client: every query is scoped by tenant_id explicitly. */
export class SupabaseStore implements PipelineStore {
  constructor(private readonly db: SupabaseClient) {}

  /** For writes that return no rows: only fail on error. */
  private ok(res: { error: { message: string } | null }, what: string): void {
    if (res.error) throw new Error(`${what}: ${res.error.message}`);
  }

  private check<T>(
    res: { data: T; error: { message: string; code?: string } | null },
    what: string,
  ): NonNullable<T> {
    if (res.error) throw new Error(`${what}: ${res.error.message}`);
    if (res.data === null || res.data === undefined) throw new Error(`${what}: no data returned`);
    return res.data;
  }

  async tenantIdBySlug(slug: string) {
    const { data } = await this.db.from("tenants").select("id").eq("slug", slug).maybeSingle();
    return data?.id ?? null;
  }

  async settings(tenantId: string) {
    return this.check(
      await this.db.from("tenant_settings").select("*").eq("tenant_id", tenantId).single(),
      "settings",
    ) as TenantSettings & {
      kill_switch: boolean;
    };
  }

  async claimMessage(provider: string, providerMessageId: string, tenantId: string) {
    const { error } = await this.db
      .from("processed_messages")
      .insert({ provider, provider_message_id: providerMessageId, tenant_id: tenantId });
    if (!error) return true;
    if (error.code === "23505") return false; // already seen — never processed twice
    throw new Error(`claim: ${error.message}`);
  }

  async sweepStale(olderThanMinutes: number) {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
    const { data, error } = await this.db
      .from("processed_messages")
      .update({ status: "failed", last_error: "stale: run did not finish (crash or timeout)" })
      .eq("status", "processing")
      .lt("updated_at", cutoff)
      .select("tenant_id, ticket_id");
    if (error) throw new Error(`sweep: ${error.message}`);
    for (const row of data ?? []) {
      if (row.ticket_id)
        await this.updateTicket(row.tenant_id, row.ticket_id, { status: "needs_attention" });
      await this.audit(row.tenant_id, {
        actorType: "system",
        action: "message_stale",
        entityType: "ticket",
        entityId: row.ticket_id ?? undefined,
        reason: "processing did not finish; handed to a human",
      });
    }
    return data?.length ?? 0;
  }

  async finishMessage(
    provider: string,
    providerMessageId: string,
    status: "done" | "skipped" | "failed",
    ticketId: string | null,
    error?: string,
  ) {
    await this.db
      .from("processed_messages")
      .update({ status, ticket_id: ticketId, last_error: error ?? null })
      .eq("provider", provider)
      .eq("provider_message_id", providerMessageId);
  }

  async findCustomerIdByEmail(tenantId: string, email: string) {
    const { data } = await this.db
      .from("customers")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("email", email.toLowerCase())
      .maybeSingle();
    return data?.id ?? null;
  }

  async findOrCreateTicket(
    tenantId: string,
    channel: ChannelId,
    threadKey: string,
    init: {
      customerId: string | null;
      requesterEmail: string | null;
      subject: string | null;
      senderVerified: boolean;
    },
    retried = false,
  ): Promise<TicketRef> {
    const existing = await this.db
      .from("tickets")
      .select("id, status, customer_id, ai_reply_count, first_response_at")
      .eq("tenant_id", tenantId)
      .eq("channel", channel)
      .eq("external_thread_id", threadKey)
      .maybeSingle();
    if (existing.error) throw new Error(`ticket lookup: ${existing.error.message}`);
    if (existing.data) {
      return {
        id: existing.data.id,
        status: existing.data.status,
        customerId: existing.data.customer_id,
        aiReplyCount: existing.data.ai_reply_count,
        created: false,
        firstResponseAt: existing.data.first_response_at,
      };
    }
    const inserted = await this.db
      .from("tickets")
      .insert({
        tenant_id: tenantId,
        channel,
        external_thread_id: threadKey,
        customer_id: init.customerId,
        requester_email: init.requesterEmail,
        subject: init.subject?.slice(0, 300) ?? null,
        sender_verified: init.senderVerified,
      })
      .select("id, status")
      .single();
    // A concurrent creator won the unique (tenant, channel, thread) race: read theirs — once.
    if (inserted.error?.code === "23505" && !retried)
      return this.findOrCreateTicket(tenantId, channel, threadKey, init, true);
    const row = this.check(inserted, "ticket");
    return {
      id: row.id,
      status: row.status,
      customerId: init.customerId,
      aiReplyCount: 0,
      created: true,
      firstResponseAt: null,
    };
  }

  async addMessage(
    tenantId: string,
    ticketId: string,
    m: {
      direction: "inbound" | "outbound";
      author: "customer" | "ai" | "human" | "system";
      status: MessageStatus;
      body: string;
      providerMessageId?: string | null;
      metadata?: Record<string, unknown>;
    },
  ) {
    const row = this.check(
      await this.db
        .from("messages")
        .insert({
          tenant_id: tenantId,
          ticket_id: ticketId,
          direction: m.direction,
          author: m.author,
          status: m.status,
          body: m.body,
          provider_message_id: m.providerMessageId ?? null,
          metadata: m.metadata ?? {},
          sent_at: m.status === "sent" ? new Date().toISOString() : null,
        })
        .select("id")
        .single(),
      "message",
    );
    return row.id as string;
  }

  async conversation(tenantId: string, ticketId: string) {
    const rows = this.check(
      await this.db
        .from("messages")
        .select("author, body, status")
        .eq("tenant_id", tenantId)
        .eq("ticket_id", ticketId)
        .in("status", ["received", "sent"])
        // Newest 40 (then oldest-first): long threads must never drop the latest customer message.
        .order("created_at", { ascending: false })
        .limit(40),
      "conversation",
    );
    return [...rows].reverse().map(
      (r) =>
        ({
          author: r.author === "customer" ? "customer" : r.author === "ai" ? "ai" : "human",
          body: r.body,
        }) as const,
    );
  }

  async saveRun(tenantId: string, ticketId: string, triggerMessageId: string, r: AgentResult) {
    const primary = r.models.at(-1) ?? "none:none";
    const [provider, ...model] = primary.split(":");
    const run = this.check(
      await this.db
        .from("agent_runs")
        .insert({
          tenant_id: tenantId,
          ticket_id: ticketId,
          trigger_message_id: triggerMessageId,
          provider,
          model: model.join(":") || "none",
          prompt_version: r.promptVersion,
          status: r.outcome === "error" ? "failed" : "completed",
          outcome: r.outcome,
          confidence: r.classification?.confidence ?? null,
          steps: r.steps,
          tokens_in: r.usage.inputTokens,
          tokens_out: r.usage.outputTokens,
          est_cost_usd: estimateCostUsd(r.models, r.usage),
          latency_ms: r.latencyMs,
          error: r.escalation?.reasons.includes("agent_error")
            ? maskPII(r.escalation.summary).slice(0, 500)
            : null,
          finished_at: new Date().toISOString(),
        })
        .select("id")
        .single(),
      "run",
    );
    if (r.trace.length) {
      const events = r.trace.map((t) => ({
        tenant_id: tenantId,
        run_id: run.id,
        seq: t.seq,
        type: t.type,
        name: t.name,
        input: maskDeep(t.input ?? null),
        output: maskDeep(t.output ?? null),
        latency_ms: t.latencyMs ?? null,
        tokens_in: t.tokensIn ?? null,
        tokens_out: t.tokensOut ?? null,
      }));
      this.ok(await this.db.from("trace_events").insert(events), "trace");
    }
    return run.id as string;
  }

  async updateTicket(tenantId: string, ticketId: string, patch: Record<string, unknown>) {
    this.ok(
      await this.db.from("tickets").update(patch).eq("tenant_id", tenantId).eq("id", ticketId),
      "ticket update",
    );
  }

  async createEscalation(
    tenantId: string,
    ticketId: string,
    e: {
      runId: string | null;
      reasonCodes: string[];
      summary: string;
      investigation: unknown;
      suggestedReply: string | null;
      pendingAction?: unknown;
    },
  ) {
    const row = this.check(
      await this.db
        .from("escalations")
        .insert({
          tenant_id: tenantId,
          ticket_id: ticketId,
          run_id: e.runId,
          reason_codes: e.reasonCodes,
          summary: e.summary.slice(0, 2000),
          investigation: maskDeep(e.investigation),
          suggested_reply: e.suggestedReply,
          pending_action: e.pendingAction ?? null,
        })
        .select("id")
        .single(),
      "escalation",
    );
    return row.id as string;
  }

  async audit(
    tenantId: string,
    e: {
      actorType: "ai" | "human" | "system";
      actorId?: string;
      action: string;
      entityType: string;
      entityId?: string;
      reason?: string;
      details?: unknown;
    },
  ) {
    await this.db.from("audit_log").insert({
      tenant_id: tenantId,
      actor_type: e.actorType,
      actor_id: e.actorId ?? null,
      action: e.action,
      entity_type: e.entityType,
      entity_id: e.entityId ?? null,
      reason: e.reason ? maskPII(e.reason).slice(0, 1000) : null,
      details: maskDeep(e.details ?? {}),
    });
  }

  async rateLimit(key: string, windowSeconds: number, max: number) {
    const { data, error } = await this.db.rpc("rate_limit_hit", {
      p_key: key,
      p_window_seconds: windowSeconds,
      p_max: max,
    });
    if (error) throw new Error(`rate limit: ${error.message}`);
    return data === true;
  }

  async ticketsCreatedToday(tenantId: string) {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const { count } = await this.db
      .from("tickets")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .gte("created_at", since.toISOString());
    return count ?? 0;
  }

  async addUsage(provider: string, metric: string, value: number) {
    if (!value) return;
    await this.db.rpc("usage_add", { p_provider: provider, p_metric: metric, p_value: value });
  }

  async channelState(tenantId: string, channel: ChannelId) {
    const { data } = await this.db
      .from("channel_state")
      .select("state")
      .eq("tenant_id", tenantId)
      .eq("channel", channel)
      .maybeSingle();
    return (data?.state ?? {}) as Record<string, unknown>;
  }

  async setChannelState(tenantId: string, channel: ChannelId, state: Record<string, unknown>) {
    this.ok(
      await this.db
        .from("channel_state")
        .upsert({ tenant_id: tenantId, channel, state, updated_at: new Date().toISOString() }),
      "channel state",
    );
  }
}
