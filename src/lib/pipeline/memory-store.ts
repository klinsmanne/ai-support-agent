import type { AgentResult } from "../agent/orchestrator.ts";
import type { MemoryRepo } from "../agent/memory-repo.ts";
import type { ChannelId } from "../channels/types.ts";
import type { MessageStatus, PipelineStore, TicketRef } from "./store.ts";

/** In-memory PipelineStore for tests and evals; shares tenant data with a MemoryRepo. */
export class MemoryStore implements PipelineStore {
  processed = new Map<string, { status: string; attempts: number }>();
  tickets: (Record<string, unknown> & {
    id: string;
    tenant_id: string;
    channel: ChannelId;
    external_thread_id: string;
    status: string;
    ai_reply_count: number;
  })[] = [];
  messages: {
    id: string;
    tenant_id: string;
    ticket_id: string;
    direction: string;
    author: string;
    status: MessageStatus;
    body: string;
    metadata?: Record<string, unknown>;
  }[] = [];
  runs: { id: string; ticketId: string; result: AgentResult }[] = [];
  escalations: {
    id: string;
    ticketId: string;
    reasonCodes: string[];
    suggestedReply: string | null;
  }[] = [];
  auditLog: { action: string; reason?: string }[] = [];
  private limits = new Map<string, number>();
  private state = new Map<string, Record<string, unknown>>();
  usage = new Map<string, number>();

  constructor(
    private readonly repo: MemoryRepo,
    private readonly slugs: Record<string, string>,
  ) {}

  async tenantIdBySlug(slug: string) {
    return this.slugs[slug] ?? null;
  }
  async settings(tenantId: string) {
    return this.repo.getSettings(tenantId);
  }
  async claimMessage(provider: string, id: string) {
    const key = `${provider}:${id}`;
    if (this.processed.has(key)) return false;
    this.processed.set(key, { status: "processing", attempts: 1 });
    return true;
  }
  async finishMessage(provider: string, id: string, status: "done" | "skipped" | "failed") {
    this.processed.set(`${provider}:${id}`, { status, attempts: 1 });
  }
  async findCustomerIdByEmail(tenantId: string, email: string) {
    return this.repo.findCustomerByEmail(tenantId, email)?.id ?? null;
  }
  async findOrCreateTicket(
    tenantId: string,
    channel: ChannelId,
    threadKey: string,
    init: { customerId: string | null; senderVerified: boolean },
  ): Promise<TicketRef> {
    const t = this.tickets.find(
      (x) =>
        x.tenant_id === tenantId && x.channel === channel && x.external_thread_id === threadKey,
    );
    if (t)
      return {
        id: t.id,
        status: t.status,
        customerId: (t.customer_id as string | null) ?? null,
        aiReplyCount: t.ai_reply_count,
        created: false,
        firstResponseAt: (t.first_response_at as string) ?? null,
      };
    const id = `ticket-${this.tickets.length + 1}`;
    this.tickets.push({
      id,
      tenant_id: tenantId,
      channel,
      external_thread_id: threadKey,
      status: "new",
      ai_reply_count: 0,
      customer_id: init.customerId,
      sender_verified: init.senderVerified,
      created_at: Date.now(),
    });
    return {
      id,
      status: "new",
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
      author: string;
      status: MessageStatus;
      body: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    const id = `msg-${this.messages.length + 1}`;
    this.messages.push({ id, tenant_id: tenantId, ticket_id: ticketId, ...m });
    return id;
  }
  async conversation(tenantId: string, ticketId: string) {
    return this.messages
      .filter(
        (m) =>
          m.tenant_id === tenantId &&
          m.ticket_id === ticketId &&
          (m.status === "received" || m.status === "sent"),
      )
      .slice(-40) // same window as production: newest 40, oldest first
      .map((m) => ({
        author: (m.author === "customer" ? "customer" : m.author === "ai" ? "ai" : "human") as
          "customer" | "ai" | "human",
        body: m.body,
      }));
  }
  async saveRun(_tenantId: string, ticketId: string, _trigger: string, result: AgentResult) {
    const id = `run-${this.runs.length + 1}`;
    this.runs.push({ id, ticketId, result });
    return id;
  }
  async updateTicket(tenantId: string, ticketId: string, patch: Record<string, unknown>) {
    const t = this.tickets.find((x) => x.tenant_id === tenantId && x.id === ticketId);
    if (t) Object.assign(t, patch);
  }
  async createEscalation(
    _tenantId: string,
    ticketId: string,
    e: { reasonCodes: string[]; suggestedReply: string | null },
  ) {
    const id = `esc-${this.escalations.length + 1}`;
    this.escalations.push({
      id,
      ticketId,
      reasonCodes: e.reasonCodes,
      suggestedReply: e.suggestedReply,
    });
    return id;
  }
  async audit(_tenantId: string, e: { action: string; reason?: string }) {
    this.auditLog.push({ action: e.action, reason: e.reason });
  }
  async rateLimit(key: string, _window: number, max: number) {
    const n = (this.limits.get(key) ?? 0) + 1;
    this.limits.set(key, n);
    return n <= max;
  }
  async ticketsCreatedToday(tenantId: string) {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    return this.tickets.filter(
      (t) => t.tenant_id === tenantId && Number(t.created_at) >= today.getTime(),
    ).length;
  }
  async sweepStale() {
    return 0; // in-memory runs can't crash half-way across processes
  }
  async addUsage(provider: string, metric: string, value: number) {
    const k = `${provider}:${metric}`;
    this.usage.set(k, (this.usage.get(k) ?? 0) + value);
  }
  async channelState(tenantId: string, channel: ChannelId) {
    return this.state.get(`${tenantId}:${channel}`) ?? {};
  }
  async setChannelState(tenantId: string, channel: ChannelId, state: Record<string, unknown>) {
    this.state.set(`${tenantId}:${channel}`, state);
  }
}
