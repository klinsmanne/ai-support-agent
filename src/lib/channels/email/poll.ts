import { ingestMessage, type IngestResult, type PipelineDeps } from "../../pipeline/ingest.ts";
import { GmailError, type GmailClient } from "./gmail-client.ts";
import { parseGmailMessage } from "./parse.ts";

export interface PollReport {
  fetched: number;
  pending: number;
  results: { id: string; status: IngestResult["status"] | "error"; outcome?: string }[];
  swept: number;
  cursor: string | null;
  error?: string;
}

/** Processing budget per poll: each ticket can take up to ~45 s and the function has 300 s. */
const MAX_PER_POLL = 4;
const MAX_PENDING = 200;
const MAX_TRIES = 3;

type Pending = { id: string; tries: number };

/**
 * One polling cycle (triggered every ~2 min by Supabase pg_cron → signed HTTPS call).
 * New message ids go into a persistent queue and the Gmail history cursor advances right away,
 * so a backlog larger than one cycle's budget drains over the next cycles instead of stalling.
 */
export async function pollGmail(
  gmail: GmailClient,
  deps: PipelineDeps,
  cursorTenantId: string,
): Promise<PollReport> {
  const swept = await deps.store.sweepStale(10).catch(() => 0);
  const state = await deps.store.channelState(cursorTenantId, "email");
  let cursor = (state.historyId as string | undefined) ?? null;
  const pending: Pending[] = Array.isArray(state.pending) ? (state.pending as Pending[]) : [];
  let fresh: string[] = [];

  try {
    if (!cursor) {
      const profile = await gmail.profile();
      fresh = (await gmail.recentInboxIds()).reverse(); // messages.list is newest-first
      cursor = profile.historyId;
    } else {
      const page = await gmail.newMessageIdsSince(cursor); // history is already oldest-first
      fresh = page.ids;
      cursor = page.historyId;
    }
  } catch (error) {
    if (error instanceof GmailError && error.status === 404) {
      // Cursor expired (inbox quiet for > ~1 week): resync from recent mail; dedupe prevents repeats.
      const profile = await gmail.profile();
      fresh = (await gmail.recentInboxIds()).reverse();
      cursor = profile.historyId;
    } else {
      return {
        fetched: 0,
        pending: pending.length,
        results: [],
        swept,
        cursor,
        error: (error as Error).message,
      };
    }
  }

  const queue = [...pending];
  for (const id of fresh) if (!queue.some((p) => p.id === id)) queue.push({ id, tries: 0 });

  const results: PollReport["results"] = [];
  const remaining: Pending[] = [];
  let budget = MAX_PER_POLL;
  for (const item of queue) {
    if (budget <= 0) {
      remaining.push(item);
      continue;
    }
    try {
      const message = await gmail.getMessage(item.id);
      if (message.labelIds?.includes("SENT") || message.labelIds?.includes("DRAFT")) continue;
      const res = await ingestMessage(parseGmailMessage(message), deps);
      results.push({
        id: item.id,
        status: res.status,
        outcome: "outcome" in res ? res.outcome : undefined,
      });
      // Duplicates are cheap (ledger hit) and don't consume the agent budget.
      if (res.status !== "duplicate") {
        budget--;
        await gmail.labelProcessed(item.id).catch(() => {});
      }
    } catch (error) {
      // One bad message (deleted, transient API error) must not stall the inbox.
      results.push({ id: item.id, status: "error" });
      if (item.tries + 1 < MAX_TRIES) remaining.push({ id: item.id, tries: item.tries + 1 });
      else {
        await deps.store
          .audit(cursorTenantId, {
            actorType: "system",
            action: "email_fetch_failed",
            entityType: "message",
            entityId: item.id,
            reason: (error as Error).message.slice(0, 200),
          })
          .catch(() => {});
      }
    }
  }

  await deps.store.setChannelState(cursorTenantId, "email", {
    ...state,
    historyId: cursor,
    pending: remaining.slice(0, MAX_PENDING),
    lastPollAt: new Date().toISOString(),
  });
  return { fetched: fresh.length, pending: remaining.length, results, swept, cursor };
}
