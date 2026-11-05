# What I learned

The concepts behind this project, each with the moment it became real.

**The agent loop.** An agent is a loop: the model reads the conversation, either answers or asks to call a tool, code runs the tool and feeds back the result, and the loop repeats. The hard part isn't the loop. It's the stop conditions: a step limit (8), a time budget (45 s), a rule that a reply can't be batched with other tool calls (so it can't claim results it hasn't seen), and a single nudge when a model returns an empty turn. Free models really do return empty turns; the evals found it.

**Function calling.** Tools are contracts, not suggestions. Each one has a narrow Zod schema (order number, amount, reason), never free-form queries or URLs. Models still break contracts: Groq's gpt-oss sometimes called tools that don't exist ("json", "cJSON"), which is why the adapter retries that specific error and every argument is validated before anything runs.

**RAG.** Retrieval is what keeps policy answers honest: the agent may only quote the client's help center, and cites it. Hybrid search (vectors plus keywords) works better than either alone. Then privacy got involved: the free embedding API trains on inputs, so email uses keyword-only search. In engineering, the "best" technique is often constrained by something that isn't technical.

**Multi-tenancy.** Isolation has to hold at every layer at once:

- every query is scoped by tenant;
- composite foreign keys mean a row can't point at another tenant's data;
- row-level security covers every table, with tests that try to break it.

A new client is configuration only, and proving that with a second, deliberately different client (Cadence Analytics) made the abstractions honest.

**Guardrails.** Put rules in code and treat the model as untrusted: it requests, code decides. The best lesson came from a security review. I'd added Markdown stripping for email _after_ the output check, so `**https**://evil.com` passed the check and was reassembled into a real link. Validate exactly what leaves the system.

**Prompt injection.** It can't be solved by detection alone, so detection is just one layer:

- inbound text is wrapped as untrusted data;
- suspected injection removes the write tools and routes to a human;
- the model has no authority anyway.

Even a fully hijacked model can only _ask_ for a refund that the policy engine then refuses.

**Human in the loop.** Escalation is a product feature, not a failure. A good handoff (summary, evidence, a draft, one-click approve that runs the action _before_ sending the reply) is what makes a cautious client say yes. So is the staged rollout: shadow, then draft-only, then auto-send, with a kill switch.

**Evals.** Without evals, a model choice is an opinion. Deterministic checks catch policy and safety failures; an LLM judge catches what regexes can't. The judge found a model claiming it had "started the process" of a carrier trace, which my regex missed because of a curly apostrophe. Judges have failure modes too: the first one contradicted its own reasoning until it had to write the reasoning first. Treat the judge as a pointer, and let deterministic checks gate.

**Model selection.** The smaller models won. Gemini 3.5 Flash-Lite (98%) and gpt-oss-20b (96%) beat the plan to use the biggest free model, which free-tier quotas wouldn't even let me measure. Data-use terms matter as much as quality: email uses Groq because its terms forbid training on inputs.

**Observability.** Every ticket stores a full trace: model calls, tool calls with inputs and outputs, retrieved passages, policy decisions, guardrail verdicts, latency and tokens. When the live test produced a reply with raw `**` in it, the trace showed exactly where. Alerts email me on repeated failures; usage is tracked against free-tier limits.

**CI/CD.** CI blocks merges on lint, types, tests, a secret scan, a dependency audit, and an eval gate that fails if the prompt changed without new results. Deployment taught humility: the post-deploy smoke tests never ran because this Vercel setup doesn't emit the GitHub event I'd assumed. Now `/api/health` reports the commit, and the workflow waits for it.

**Working with Claude Code.**

- `CLAUDE.md` as the project's constitution.
- Permissions that let routine work flow but stop for anything risky.
- Hooks that block secret files.
- One branch and PR per milestone, and `PROGRESS.md` as memory across sessions.
- Independent review subagents before every merge. They found real bugs every time: a demo reset that could wipe a real client, a retention purge that could delete open tickets, overlapping inbox polls.

**Beyond the tech.** Be honest about what's measured and what's projected. Write the runbook, because writing "invite the client's team" exposed a permission bug (ADR-025). And when something goes wrong, like a secret appearing in a chat, say so and rotate it.
