# Business case: AI support agent for Harbor & Pine

_Fictional client. **Baseline** figures come from [discovery](DISCOVERY.md). **Measured** figures come from the live system and the evals. Everything else is an **assumption**, labeled and easy to change._

## 1. Executive summary

At Harbor & Pine's volume, the agent is projected to save **≈ $395K a year** in support cost, and to give back **≈ 560 agent hours a month**. Year-one total cost of ownership is **≈ $73K** (assumptions in §4), so payback comes in **≈ 2 months**. The pilot's risk is contained by design: refunds are limited in code, every action is audited, and rollout moves from shadow to draft-only to auto-send only when agreed gates are met.

## 2. Baseline (from discovery)

| Item                         | Value                                   |
| ---------------------------- | --------------------------------------- |
| Tickets                      | 6,500 a month (78,000 a year)           |
| Cost per ticket              | $7.80 (≈ 8 agent-minutes, fully loaded) |
| Annual support handling cost | 78,000 × $7.80 = **$608,400**           |
| Seasonal temporary staff     | ≈ $40,000 a year                        |
| Median first response        | 9.5 h                                   |

## 3. Value model

Each ticket ends one of three ways:

- **auto-resolved** by the agent;
- **assisted:** the agent drafts and a person approves, ≈ 4 agent-minutes;
- **fully human.**

| Outcome                   | Cost per ticket | Basis                                                                                         |
| ------------------------- | --------------- | --------------------------------------------------------------------------------------------- |
| Auto-resolved             | ≈ $0.003        | **Measured:** $0.0005–$0.0026 model cost per ticket at paid list prices                       |
| Assisted (draft approved) | $3.90           | Half of the $7.80 baseline (4 of 8 minutes), an **assumption** to validate in draft-only mode |
| Fully human               | $7.80           | Baseline                                                                                      |

**Blended cost per ticket** = a × $0.003 + d × $3.90 + (1 − a − d) × $7.80, where a is the auto-resolution share and d the assisted share.

### Sensitivity: the auto-resolution rate is the lever

| Scenario     | Auto (a) | Assisted (d) | Blended cost/ticket | Annual cost | **Annual savings** | Agent hours saved/month |
| ------------ | -------: | -----------: | ------------------: | ----------: | -----------------: | ----------------------: |
| Conservative |      30% |          30% |               $4.29 |    $334,690 |       **$273,710** |                     390 |
| Target       |      50% |          30% |               $2.73 |    $213,060 |       **$395,340** |                     563 |
| Strong       |      70% |          20% |               $1.56 |    $121,840 |       **$486,560** |                     693 |

Hours saved = 6,500 × (a × 8 + d × 4) ÷ 60. The target and strong cases beat the < $3.50 target; the conservative case ($4.29) does not, so the pilot gate in §6 requires a projected auto-resolution of at least 40%. The 50% target alone, with no drafts, gives $3.90, which is why the assisted path matters.

**What's measured so far:**

- the production models handle 96–98% of a 47-case realistic test set fully correctly, with 0 safety failures;
- a live email was answered 6.7 s after it was picked up;
- the live demo tenant shows auto-resolution of about 44% (4 of 9 tickets): a small, deliberately adversarial sample of test conversations, not client traffic.

The real auto-resolution rate must be measured in **shadow mode on the client's own traffic** before any of this is booked as savings.

## 4. Total cost of ownership, year one (assumptions to adjust)

| Item                          |   Year-1 cost | Assumption                                                                                   |
| ----------------------------- | ------------: | -------------------------------------------------------------------------------------------- |
| Pilot build and deployment    |       $60,000 | ≈ 6 weeks of a small forward-deployed team (the engagement fee); replace with the actual SOW |
| Model usage                   |          $200 | 78,000 tickets × $0.0026 (measured Flash-Lite cost); gpt-oss-20b would be ≈ $40              |
| Hosting, database, monitoring |        $1,800 | Paid plans for headroom and backups at ≈ $150 a month (check current vendor pricing)         |
| Ongoing tuning and evals      |        $9,000 | ≈ 2 days a month of analyst or engineer time                                                 |
| Support lead review time      |        $2,000 | ≈ 30 minutes a week reviewing samples and drafts                                             |
| **Total**                     | **≈ $73,000** |                                                                                              |

**Payback** = $73,000 ÷ ($395,340 ÷ 12) ≈ **2.2 months** at target. Even in the conservative case, payback is about 3.2 months.

**Not counted (upside):**

- faster responses reducing repeat contacts (discovery: follow-ups create duplicate tickets);
- fewer seasonal hires (≈ $40K);
- weekend coverage;
- consistent, audited refunds (finance's leakage concern).

## 5. SWOT

|                                                                                                                                                                                    |                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Strengths:** policy enforced in code, so the support lead's fear is addressed by design; measured quality (evals) before launch; low running cost; multi-client by configuration | **Weaknesses:** simulated refund and carrier integrations in the pilot; one shared inbox; free-tier limits in the demo deployment                                                                                |
| **Opportunities:** extend to proactive delay notifications, returns automation, and the client's other brands; reuse the onboarding pattern for new clients                        | **Threats:** model or provider changes (mitigated by the eval gate and fallback chain); customer distrust of AI (disclosure plus an easy human option); policy drift between the help center and the real policy |

## 6. Pilot success criteria (the decision to scale)

After 4 weeks (shadow, then draft-only):

1. **0** unauthorized or out-of-policy actions.
2. ≥ 80% of drafts approved without edits.
3. Escalation precision ≥ 90% on a weekly sample of 20.
4. Projected auto-resolution ≥ 40% from shadow-mode traffic.
5. No CSAT regression in the draft-only cohort.

If all five hold, move to auto-send for the top three intents and re-measure monthly against §3.
