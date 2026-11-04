"use client";

import { useActionState, useState } from "react";
import { approveEscalation, rejectEscalation, type ActionResult } from "@/app/dashboard/actions";

/** Approve / edit / reject a suggested reply. Server actions re-check the role; viewers see it read-only. */
export function EscalationPanel(props: {
  tenantId: string;
  escalationId: string;
  suggestedReply: string | null;
  canEdit: boolean;
  pendingAction: string | null;
}) {
  const [approveState, approve, approving] = useActionState<ActionResult | null, FormData>(
    approveEscalation,
    null,
  );
  const [rejectState, reject, rejecting] = useActionState<ActionResult | null, FormData>(
    rejectEscalation,
    null,
  );
  // Show the result of whichever button was pressed last, not always the approve result.
  const [last, setLast] = useState<"approve" | "reject" | null>(null);
  const state = last === "reject" ? rejectState : last === "approve" ? approveState : null;
  return (
    <div className="space-y-3">
      <form action={approve} className="space-y-2">
        <input type="hidden" name="tenantId" value={props.tenantId} />
        <input type="hidden" name="escalationId" value={props.escalationId} />
        <label className="block text-xs text-zinc-500" htmlFor={`reply-${props.escalationId}`}>
          Suggested reply {props.canEdit ? "(edit before sending if needed)" : ""}
        </label>
        <textarea
          id={`reply-${props.escalationId}`}
          name="reply"
          defaultValue={props.suggestedReply ?? ""}
          readOnly={!props.canEdit}
          rows={7}
          className="w-full rounded-lg border border-zinc-300 bg-white p-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        />
        {props.pendingAction && (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            Approving also executes: {props.pendingAction}
          </p>
        )}
        {props.canEdit ? (
          <div className="flex gap-2">
            <button
              onClick={() => setLast("approve")}
              disabled={approving || rejecting}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            >
              {approving ? "Sending…" : "Approve & send"}
            </button>
            <button
              formAction={reject}
              onClick={() => setLast("reject")}
              disabled={approving || rejecting}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700"
            >
              Reject — I&apos;ll handle it
            </button>
          </div>
        ) : (
          <p className="text-xs text-zinc-500">
            Read-only demo: approving and sending is disabled.
          </p>
        )}
      </form>
      {state && (
        <p
          className={`text-sm ${state.ok ? "text-emerald-700 dark:text-emerald-300" : "text-red-600"}`}
          role="status"
        >
          {state.message}
        </p>
      )}
    </div>
  );
}
