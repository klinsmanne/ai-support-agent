# Free-Tier Research (verified 2026-11-03 against official docs)

Inputs to model choice and infrastructure decisions. Re-verify before relying on limits — providers change them often.

## Gemini API (free tier)

- Free text models with function calling + structured output: `gemini-3.8-flash` (most capable free model, 1M context), `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`. Pro models are not on the free tier. `gemini-2.5-*` is deprecated (rerouted from 2026-12-01).
- Rate limits are no longer published; view them per project in Google AI Studio. Third-party reports suggest ~5–15 RPM and ~100–1,500 RPD for Flash-class models.
- Embeddings: `gemini-embedding-2` (8,192-token input; `output_dimensionality` 128–3072, 768 recommended, auto-normalized). Free.
- **Caveat:** free-tier content may be used to improve Google products → fictional data only (which we use anyway).
- Source: https://aistudio.google.com/docs/pricing, /docs/models, /docs/rate-limits, /docs/embeddings

## Groq (fallback)

- All models support tool use. Production: `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `llama-3.3-70b-versatile`, `llama-3.1-8b-instant` (131K context).
- Base limits (gpt-oss-120b): 30 RPM, 1K RPD, 8K TPM, 200K TPD. gpt-oss models don't support parallel tool calls.
- Source: https://console.groq.com/docs/models, /docs/rate-limits, /docs/tool-use

## Vercel Hobby

- Functions: 300 s max duration. Cron: **at most once per day** → not usable for email polling. Non-commercial use only (fine for a portfolio demo).
- Source: https://vercel.com/docs/limits, /docs/cron-jobs/usage-and-pricing, /docs/plans/hobby

## Supabase Free

- 500 MB DB, 2 active projects, **pauses after 7 days of inactivity** → keep-alive needed. pgvector available.
- Source: https://supabase.com/pricing

## Gmail API

- Quota is free at our scale (`history.list` = 2 units, `messages.get` = 20, `send` = 100).
- Push (`users.watch` + Pub/Sub) needs a GCP billing account → **violates the no-card rule**. Polling `history.list` needs no billing.
- OAuth app in "Testing" status: refresh tokens for Gmail scopes **expire after 7 days** → weekly re-auth or app verification.
- Source: https://developers.google.com/workspace/gmail/api/reference/quota, /guides/push; https://developers.google.com/identity/protocols/oauth2

## Cloudflare Turnstile

- Free, unlimited challenges, no card. Source: https://developers.cloudflare.com/turnstile/plans/

## Anthropic (inactive adapter)

- `claude-haiku-5-5` (from $0.10/$0.50 per MTok), `claude-sonnet-5-5` ($2/$10), `claude-opus-5-5` ($4/$20). Source: https://platform.claude.com/docs/en/about-claude/models/overview
