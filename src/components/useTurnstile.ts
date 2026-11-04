"use client";

import { useCallback, useEffect, useRef } from "react";

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render(
    el: HTMLElement,
    opts: {
      sitekey: string;
      appearance?: "always" | "execute" | "interaction-only";
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;
function loadScript(): Promise<void> {
  scriptPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      scriptPromise = null;
      reject(new Error("Turnstile failed to load"));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/**
 * Cloudflare Turnstile (free, no card): proves a human is starting a chat session before the
 * server spends model quota on it. Invisible unless Cloudflare wants an interaction. Returns a
 * container ref and `take()`, which waits briefly for a fresh single-use token. Without a site
 * key (local dev without keys) it's a no-op and the server decides whether that's allowed.
 */
export function useTurnstile(siteKey: string | undefined) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const token = useRef<string | null>(null);
  // "failed" (script blocked, network, widget error) makes take() return at once, not stall.
  const status = useRef<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !container.current || !window.turnstile) return;
        widgetId.current = window.turnstile.render(container.current, {
          sitekey: siteKey,
          appearance: "interaction-only",
          callback: (t) => {
            token.current = t;
            status.current = "ready";
          },
          "expired-callback": () => (token.current = null),
          "error-callback": () => {
            token.current = null;
            status.current = "failed";
          },
        });
      })
      .catch(() => (status.current = "failed"));
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [siteKey]);

  /** A token for one request (tokens are single-use), or undefined if none arrives in time. */
  const take = useCallback(async (): Promise<string | undefined> => {
    if (!siteKey) return undefined;
    // Up to 30 s: an interactive challenge may need the visitor to click.
    for (
      let waited = 0;
      !token.current && status.current !== "failed" && waited < 30_000;
      waited += 200
    ) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const t = token.current ?? undefined;
    token.current = null;
    if (widgetId.current && window.turnstile) {
      window.turnstile.reset(widgetId.current);
      status.current = "loading"; // a reset widget gets another chance after an error
    }
    return t;
  }, [siteKey]);

  return { container, take };
}
