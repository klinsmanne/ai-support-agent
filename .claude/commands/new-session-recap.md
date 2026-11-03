---
description: Summarize where the project stands and produce a paste-ready prompt to resume in a fresh session
---

Prepare a handoff so work can resume in a fresh Claude Code session.

1. Read `PROGRESS.md`, `docs/DECISIONS.md`, and run `git status`, `git branch --show-current`, `git log --oneline -10`, and `gh pr list`.
2. Update `PROGRESS.md` (done / in progress / next / known issues) if it is stale, and commit it.
3. Output, in plain language for a beginner:
   - What's finished, what's in progress, what's next (max 3 bullets each).
   - A single fenced block the user can paste into a new session, e.g. "Resume the AI support agent project. Read CLAUDE.md and PROGRESS.md, check out branch X, and continue with Y."
