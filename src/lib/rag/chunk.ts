/**
 * Splits a markdown KB article into retrieval chunks, one per `##` section.
 * Each chunk is prefixed with the article title (and section heading) so it stands alone
 * when retrieved and cited. Long sections are split on paragraph boundaries.
 */
export function chunkMarkdown(
  markdown: string,
  maxChars = 1200,
): { title: string; chunks: string[] } {
  const lines = markdown.replace(/\r\n/g, "\n").trim().split("\n");
  const title = lines[0]?.startsWith("# ") ? lines.shift()!.slice(2).trim() : "Untitled";

  const sections: { heading: string | null; body: string[] }[] = [{ heading: null, body: [] }];
  for (const line of lines) {
    if (line.startsWith("## ")) sections.push({ heading: line.slice(3).trim(), body: [] });
    else sections[sections.length - 1].body.push(line);
  }

  const chunks: string[] = [];
  for (const { heading, body } of sections) {
    const text = body.join("\n").trim();
    if (!text) continue;
    const prefix = heading ? `${title} — ${heading}\n` : `${title}\n`;
    let current = "";
    for (const para of text.split(/\n{2,}/)) {
      if (current && (current + "\n\n" + para).length > maxChars) {
        chunks.push(prefix + current);
        current = para;
      } else {
        current = current ? `${current}\n\n${para}` : para;
      }
    }
    if (current) chunks.push(prefix + current);
  }
  return { title, chunks };
}
