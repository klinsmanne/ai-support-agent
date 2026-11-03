import { ingestMessage, type IngestResult, type PipelineDeps } from "../../pipeline/ingest.ts";
import { GmailError, type GmailClient } from "./gmail-client.ts";
import { parseGmailMessage } from "./parse.ts";

export interface PollReport {
  fetched: number;
  results: { id: string; status: IngestResult["status"]; outcome?: string }[];
  cursor: string | null;
  error?: string;
}

/** Processing budget per poll: each ticket can take up to ~45 s and the function has 300 s. */
const MAX_PER_POLL = 4;

/**
 * One polling cycle (triggered every ~2 min by Supabase pg_cron → signed HTTPS call).
 * Uses Gmail's history cursor so each call costs ~2 quota units when the inbox is quiet.
 * The cursor only advances past messages that were actually handled, so nothing is skipped
 * when a cycle hits its budget.
 */
export async function pollGmail(
  gmail: GmailClient,
  deps: PipelineDeps,
  cursorTenantId: string,
): Promise<PollReport> {
  const state = await deps.store.channelState(cursorTenantId, "email");
  let cursor = (state.historyId as string | undefined) ?? null;
  let ids: string[];
  let nextCursor: string;

  try {
    if (!cursor) {
      const profile = await gmail.profile();
      ids = await gmail.recentInboxIds();
      nextCursor = profile.historyId;
    } else {
      const page = await gmail.newMessageIdsSince(cursor);
      ids = page.ids;
      nextCursor = page.historyId;
    }
  } catch (error) {
    if (error instanceof GmailError && error.status === 404) {
      // Cursor expired (inbox quiet for > ~1 week): resync from recent mail; dedupe prevents repeats.
      const profile = await gmail.profile();
      ids = await gmail.recentInboxIds();
      nextCursor = profile.historyId;
    } else {
      return { fetched: 0, results: [], cursor, error: (error as Error).message };
    }
  }

  const results: PollReport["results"] = [];
  // Oldest first so replies go out in order.
  const batch = ids.reverse().slice(0, MAX_PER_POLL);
  for (const id of batch) {
    const message = await gmail.getMessage(id);
    if (message.labelIds?.includes("SENT") || message.labelIds?.includes("DRAFT")) continue;
    const res = await ingestMessage(parseGmailMessage(message), deps);
    results.push({ id, status: res.status, outcome: "outcome" in res ? res.outcome : undefined });
    if (res.status !== "duplicate") await gmail.labelProcessed(id).catch(() => {});
  }

  // Advance the cursor only when everything fetched was handled; otherwise keep it so the
  // remaining ids are fetched again next cycle (already-processed ones dedupe for free).
  if (batch.length === ids.length) cursor = nextCursor;
  await deps.store.setChannelState(cursorTenantId, "email", {
    ...state,
    historyId: cursor,
    lastPollAt: new Date().toISOString(),
  });
  return { fetched: ids.length, results, cursor };
}
