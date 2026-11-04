import { composeReplyMime, toBase64Url } from "./compose.ts";
import type { GmailMessage } from "./parse.ts";
import type { ChannelSender, OutboundReply } from "../types.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export class GmailError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GmailError";
  }
  /** invalid_grant = refresh token revoked/expired (e.g. 7-day Testing-mode expiry) → re-auth. */
  get needsReauth() {
    return this.status === 400 || this.status === 401;
  }
}

/**
 * Minimal Gmail REST client (no SDK): history-based polling, fetch, send in thread, labels.
 * Quota cost per poll ≈ 2 units (history.list) + 20 per new message — far below free limits.
 */
export class GmailClient implements ChannelSender {
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly cfg: {
      clientId: string;
      clientSecret: string;
      refreshToken: string;
      address: string;
      displayName: string;
    },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000)
      return this.accessToken.value;
    const res = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        refresh_token: this.cfg.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!res.ok || !json.access_token)
      throw new GmailError(`token refresh failed: ${json.error ?? res.status}`, res.status);
    this.accessToken = {
      value: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
    return json.access_token;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${await this.token()}`,
        "content-type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok)
      throw new GmailError(
        `gmail ${path.split("?")[0]}: ${json.error?.message ?? res.status}`,
        res.status,
      );
    return json;
  }

  async profile(): Promise<{ emailAddress: string; historyId: string }> {
    return this.call("/profile");
  }

  /**
   * New inbox message ids since `startHistoryId`. If the cursor is too old (Gmail keeps ~a week),
   * Gmail returns 404 and the caller falls back to `recentInboxIds`.
   */
  async newMessageIdsSince(startHistoryId: string): Promise<{ ids: string[]; historyId: string }> {
    const ids = new Set<string>();
    let pageToken: string | undefined;
    let latest = startHistoryId;
    do {
      const q = new URLSearchParams({
        startHistoryId,
        labelId: "INBOX",
        maxResults: "100",
      });
      // New mail AND mail moved into the inbox later (e.g. a human clicking "Not spam").
      q.append("historyTypes", "messageAdded");
      q.append("historyTypes", "labelAdded");
      if (pageToken) q.set("pageToken", pageToken);
      const page = await this.call<{
        history?: {
          messagesAdded?: { message: { id: string; labelIds?: string[] } }[];
          labelsAdded?: { message: { id: string; labelIds?: string[] }; labelIds: string[] }[];
        }[];
        historyId: string;
        nextPageToken?: string;
      }>(`/history?${q}`);
      for (const h of page.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          if (!added.message.labelIds?.includes("SENT")) ids.add(added.message.id);
        }
        for (const moved of h.labelsAdded ?? []) {
          if (moved.labelIds.includes("INBOX") && !moved.message.labelIds?.includes("SENT"))
            ids.add(moved.message.id);
        }
      }
      latest = page.historyId ?? latest;
      pageToken = page.nextPageToken;
    } while (pageToken && ids.size < 200);
    return { ids: [...ids], historyId: latest };
  }

  /** Fallback / first run: unprocessed inbox messages from the last 2 days. */
  async recentInboxIds(): Promise<string[]> {
    const q = new URLSearchParams({
      q: "in:inbox newer_than:2d -label:ai-processed",
      maxResults: "50",
    });
    const res = await this.call<{ messages?: { id: string }[] }>(`/messages?${q}`);
    return (res.messages ?? []).map((m) => m.id);
  }

  async getMessage(id: string): Promise<GmailMessage> {
    return this.call(`/messages/${encodeURIComponent(id)}?format=full`);
  }

  async send(reply: OutboundReply): Promise<{ providerMessageId: string }> {
    const raw = composeReplyMime(reply, { email: this.cfg.address, name: this.cfg.displayName });
    const sent = await this.call<{ id: string }>("/messages/send", {
      method: "POST",
      body: JSON.stringify({ raw: toBase64Url(raw), threadId: reply.threadKey }),
    });
    return { providerMessageId: sent.id };
  }

  /** Sends a new (non-reply) system email, e.g. a dashboard sign-in link. */
  async sendNew(to: string, subject: string, body: string): Promise<{ providerMessageId: string }> {
    const raw = composeReplyMime(
      { channel: "email", threadKey: "", to, subject, body },
      { email: this.cfg.address, name: this.cfg.displayName },
      { isReply: false },
    );
    const sent = await this.call<{ id: string }>("/messages/send", {
      method: "POST",
      body: JSON.stringify({ raw: toBase64Url(raw) }),
    });
    return { providerMessageId: sent.id };
  }

  /** Moves a message out of Spam into the inbox (operator action for false-positive spam). */
  async markNotSpam(messageId: string): Promise<void> {
    await this.call(`/messages/${encodeURIComponent(messageId)}/modify`, {
      method: "POST",
      body: JSON.stringify({ removeLabelIds: ["SPAM"], addLabelIds: ["INBOX"] }),
    });
  }

  /** Marks a message processed in the mailbox so humans see what the agent handled. */
  async labelProcessed(messageId: string): Promise<void> {
    const labelId = await this.ensureLabel("ai-processed");
    await this.call(`/messages/${encodeURIComponent(messageId)}/modify`, {
      method: "POST",
      body: JSON.stringify({ addLabelIds: [labelId] }),
    });
  }

  private labelCache = new Map<string, string>();
  private async ensureLabel(name: string): Promise<string> {
    const cached = this.labelCache.get(name);
    if (cached) return cached;
    const { labels } = await this.call<{ labels: { id: string; name: string }[] }>("/labels");
    let label = labels.find((l) => l.name === name);
    if (!label) {
      label = await this.call<{ id: string; name: string }>("/labels", {
        method: "POST",
        body: JSON.stringify({
          name,
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
        }),
      });
    }
    this.labelCache.set(name, label.id);
    return label.id;
  }
}
