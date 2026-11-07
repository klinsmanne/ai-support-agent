# How to keep working on this with Claude Code

## Open the project again

1. Open the **Claude** desktop app → **Code**, and choose the folder `~/Projects/ai-support-agent` (or, in a terminal: `cd ~/Projects/ai-support-agent` then `claude`). It lives outside iCloud-synced folders on purpose: iCloud creates "… 2" duplicate files during git operations.
2. Claude reads `CLAUDE.md` automatically. That file tells it what the project is, the rules ($0, never commit secrets, ask before risky actions), and that you're a beginner.
3. To pick up where you left off, paste this:

   > Resume the AI support agent project. Read CLAUDE.md and PROGRESS.md, run `git status` and `gh pr list`, then tell me where things stand and what's next.

`PROGRESS.md` is the project's memory between sessions: what's done, what's in progress, known issues.

## When a session gets long

Type `/new-session-recap`. Claude updates `PROGRESS.md` and gives you a ready-to-paste prompt for a fresh session. Start a new session with that prompt whenever the current one feels slow or forgetful.

## Project commands

Type these in Claude Code. They're defined in `.claude/commands/`:

| Command                    | What it does                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/verify`                  | Runs every quality check (lint, types, format, tests, build) and fixes the cause of any failure      |
| `/run-evals [model]`       | Runs the 47-case test suite on a model, then the report and the CI gate, and explains any failures   |
| `/compare-models`          | Compares all measured models and recommends which to use for chat and email                          |
| `/check-usage`             | Read-only health check: live site, Gmail polling, today's free-tier usage, tickets needing attention |
| `/deploy`                  | Ships the current branch safely: checks → PR → CI → reviews → merge → live smoke tests               |
| `/onboard-customer <slug>` | Adds a new client by configuration, step by step, starting in shadow mode                            |
| `/new-session-recap`       | Updates PROGRESS.md and gives you a prompt to resume in a fresh session                              |

## How changes get made (and why it's safe)

- **One branch per piece of work,** small commits, and a pull request on GitHub. `main` only changes through merged PRs, and merging deploys the live site.
- **CI on every PR:**
  - lint, types, format and about 280 tests;
  - the eval gate, which fails if the prompt changed without new eval results or a safety check fails;
  - a secret scan and a dependency audit.
- **Reviews:** before merging a milestone, Claude runs two independent review agents, one for security and one for code quality, and fixes what they find.
- **Hooks** (`.claude/settings.json`, `.claude/hooks/`) auto-format files after edits, and block any command or edit that touches secret files.
- **Permissions:** routine commands run without asking. Anything risky asks you first, with a one-sentence explanation: deleting data, changing production settings, rotating secrets, force-pushing. Say no if you're unsure.

## Secrets

Keys live in your Mac's Keychain, never in files you commit. Useful commands (Claude runs them for you):

```bash
npm run secrets status
```

```bash
npm run secrets sync
```

`status` shows which keys are set, by name only. `sync` refreshes the local env file the dev server reads. To add or replace a key, Claude tells you the exact page to copy it from and runs `npm run secrets set NAME`; you paste the value when asked. Never paste passwords into the chat.

## Good first requests

- "Run `/check-usage` and tell me if anything needs attention."
- "Add an eval case for a customer asking to cancel an order, run it, and show me the result."
- "Change Harbor & Pine's refund limit to $100 and explain what changes."
- "There's a Dependabot PR; check whether it's safe to merge."
