/**
 * Splits a markdown KB article into retrieval chunks, one per `##` section.
 * Each chunk is prefixed with the article title (and section heading) so it stands alone
 * when retrieved and cited. Long sections are split on paragraph boundaries, and a single
 * oversized paragraph is split on sentence boundaries (hard-cut as a last resort).
 * The prefix counts toward `maxChars`. `##` inside fenced code blocks is not a heading.
 */
export function chunkMarkdown(
  markdown: string,
  maxChars = 1200,
): { title: string; chunks: string[] } {
  const lines = markdown.replace(/^﻿/, "").replace(/\r\n/g, "\n").trim().split("\n");
  const titleMatch = /^#(?!#)\s*(.+)$/.exec(lines[0] ?? "");
  const title = titleMatch ? (lines.shift(), titleMatch[1].trim()) : "Untitled";

  const sections: { heading: string | null; body: string[] }[] = [{ heading: null, body: [] }];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = !inFence && /^##(?!#)\s*(.+)$/.exec(line);
    if (heading) sections.push({ heading: heading[1].trim(), body: [] });
    else sections[sections.length - 1].body.push(line);
  }

  const chunks: string[] = [];
  for (const { heading, body } of sections) {
    const text = body.join("\n").trim();
    if (!text) continue;
    const prefix = heading ? `${title} — ${heading}\n` : `${title}\n`;
    const budget = Math.max(maxChars - prefix.length, 100);
    let current = "";
    const flush = () => {
      if (current) chunks.push(prefix + current);
      current = "";
    };
    for (const piece of text.split(/\n{2,}/).flatMap((p) => splitOversized(p, budget))) {
      if (current && current.length + 2 + piece.length > budget) flush();
      current = current ? `${current}\n\n${piece}` : piece;
    }
    flush();
  }
  return { title, chunks };
}

/** Breaks a paragraph longer than `budget` into sentence groups, hard-cutting runaway sentences. */
function splitOversized(paragraph: string, budget: number): string[] {
  if (paragraph.length <= budget) return [paragraph];
  const sentences = paragraph.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) ?? [paragraph];
  const parts: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    for (let i = 0; i < sentence.length; i += budget) {
      const slice = sentence.slice(i, i + budget);
      if (current && current.length + slice.length > budget) {
        parts.push(current.trim());
        current = "";
      }
      current += slice;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}
