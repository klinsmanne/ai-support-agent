"use client";

import { PREFILL_EVENT, type PrefillDetail } from "@/components/ChatWidget";

/** Scrolls to the chat and fills in a sample message (and verification details, if needed). */
export function TryButton(props: PrefillDetail) {
  return (
    <button
      type="button"
      onClick={() => {
        document.getElementById("chat")?.scrollIntoView({ behavior: "smooth", block: "center" });
        window.dispatchEvent(new CustomEvent<PrefillDetail>(PREFILL_EVENT, { detail: props }));
      }}
      className="shrink-0 rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
    >
      Try it
    </button>
  );
}
