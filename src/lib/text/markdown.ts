/**
 * Models write chat-style Markdown; a text/plain email would show the raw "**" and "#". Strips
 * emphasis, headings and code marks, and turns [text](url) into "text (url)". Code, not the
 * prompt, so the eval results for the current prompt version stay valid (live test finding).
 * The outbound guardrail validates this converted form too (validateReply), so formatting can't
 * hide a link, ID or secret that only appears once the marks are removed (security review).
 */
export function markdownToPlainText(text: string): string {
  // Emphasis marks only count at word edges, so snake__case, a/*.txt and "5 * 3" stay intact.
  return text
    .replace(/(?<![\w*])\*\*(?=\S)([^\n]*?\S)\*\*(?![\w])/g, "$1")
    .replace(/(?<![\w_])__(?=\S)([^\n]*?\S)__(?![\w_])/g, "$1")
    .replace(/(?<![\w*/\\])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)");
}
