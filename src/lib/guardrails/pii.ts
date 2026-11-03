/** Masks personal data before anything is written to logs or traces (privacy by default). */

const RULES: [RegExp, (m: string) => string][] = [
  // Emails: keep first char and domain for debuggability: o***@example.com
  [
    /\b([A-Z0-9._%+-])[A-Z0-9._%+-]*@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi,
    (m) => m.replace(/^(.)[^@]*@/, "$1***@"),
  ],
  // Card-like numbers (13–19 digits, optional spaces/dashes): keep last 4
  [/\b(?:\d[ -]?){12,18}\d\b/g, (m) => `****${m.replace(/\D/g, "").slice(-4)}`],
  // Phone numbers
  [/(?<!\d)(\+?\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}(?!\d)/g, () => "[phone]"],
  // Secrets that somehow reached a log line
  [/\b(sk-ant-|sk-|gsk_|sb_secret_|AIza)[A-Za-z0-9_-]{8,}/g, (m) => `${m.slice(0, 6)}…[redacted]`],
];

export function maskPII(text: string): string {
  return RULES.reduce((out, [re, fn]) => out.replace(re, fn), text);
}

/** Recursively masks every string in a JSON-like value. */
export function maskDeep<T>(value: T): T {
  if (typeof value === "string") return maskPII(value) as T;
  if (Array.isArray(value)) return value.map(maskDeep) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v)])) as T;
  }
  return value;
}
