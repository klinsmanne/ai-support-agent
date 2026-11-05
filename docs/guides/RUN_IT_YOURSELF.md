# Run it yourself (beginner guide)

Step by step, from an empty Mac to your own copy running on the internet. Everything is free; no credit card is needed anywhere. Expect an afternoon.

> If you only want to _see_ it, use the live demo: https://ai-support-ops-agent.vercel.app

## What you need

- A Mac. Secrets are kept in the macOS Keychain; other systems would need a small change to `scripts/secrets.mjs`.
- Free accounts: GitHub, Supabase, Google (for the Gemini API and Gmail), Groq, Vercel, Cloudflare.
- Tools: Git, Node.js 24+, the GitHub CLI (`gh`), the Supabase CLI and the Vercel CLI. On a Mac with Homebrew:

```bash
brew install git node gh supabase/tap/supabase
npm install -g vercel
```

## 1. Get the code

```bash
gh repo clone klinsmanne/ai-support-agent
cd ai-support-agent
npm install
npm run check
```

`npm run check` runs lint, type checks, formatting and about 280 tests. They need no accounts or internet. If they pass, your setup works.

## 2. Create the database (Supabase)

1. At supabase.com → **New project** (free plan). Note the project reference in its URL.
2. In the terminal:

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase db push --remote --include-seed --yes
```

This creates the tables, the security rules and the two demo companies.

3. **Project Settings → API keys:** copy the project URL, the publishable key and the secret key into the Keychain. Each command waits for you to paste the value, then press Enter and Ctrl-D:

```bash
npm run secrets set NEXT_PUBLIC_SUPABASE_URL
npm run secrets set NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
npm run secrets set SUPABASE_SECRET_KEY
```

## 3. Add the AI keys

- **Gemini:** aistudio.google.com → **Get API key**.
- **Groq:** console.groq.com → **API Keys** → **Create**.

```bash
npm run secrets set GEMINI_API_KEY
npm run secrets set GROQ_API_KEY
```

Then generate two random secrets the app uses internally:

```bash
openssl rand -hex 32 | npm run secrets set CRON_SECRET
```

```bash
openssl rand -hex 32 | npm run secrets set CSRF_SECRET
```

Check what's set (names only, never values):

```bash
npm run secrets status
```

## 4. Run it locally

```bash
npm run secrets sync
npm run kb:embed
npm run dev
```

`secrets sync` writes the git-ignored local env file from the Keychain. `kb:embed` loads the help pages into the search index. Open http://localhost:3000 and try the chat; locally, the bot check uses Cloudflare's test keys.

Try the agent from the terminal, too:

```bash
npm run agent:try
```

## 5. Connect Gmail (optional)

1. Create a new Gmail account for support.
2. In Google Cloud Console, create a project, enable the **Gmail API**, and create an **OAuth client** of type "Desktop app".
3. Store the settings:

```bash
npm run secrets set GMAIL_CLIENT_ID
npm run secrets set GMAIL_CLIENT_SECRET
npm run secrets set SUPPORT_EMAIL_ADDRESS
npm run gmail:auth
```

`gmail:auth` opens Chrome. Sign in as the support account and click Allow; Google warns that the app is unverified, which is expected for your own app. Then process the inbox once:

```bash
npm run email:poll
```

## 6. Put it online

Follow [DEPLOYMENT.md](../DEPLOYMENT.md), section "Repeat the setup". In short:

- link the project to Vercel and GitHub;
- push your secrets to Vercel;
- set `APP_URL`;
- point Supabase sign-in at your site;
- store the poll secret in Supabase Vault;
- create a Turnstile widget for your site's address;
- publish the Gmail app.

## Troubleshooting

| Problem                                      | Fix                                                                                                        |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `npm run check` fails right after cloning    | Check `node --version` is 24 or newer, then run `npm install` again                                        |
| "No API key for …"                           | `npm run secrets status`, then `npm run secrets sync`                                                      |
| AI replies are slow or escalate a lot        | Free-tier limits. Wait a minute; the dashboard's usage page shows what's left                              |
| Gmail stops working after 7 days             | The Google app is still in "Testing". Publish it (DEPLOYMENT.md step 4) and run `npm run gmail:auth` again |
| Chat says "couldn't confirm you're a person" | In production, the Turnstile widget must list your exact site address                                      |
