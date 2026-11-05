"""
Eval analysis in Python + SQL: reads the per-case eval export (evals/results/<version>/cases.ndjson,
written by `npm run eval:report` with the current scorer), queries it with DuckDB, and writes analysis/output/ANALYSIS.md plus charts.

Why a second view next to the TypeScript report: the TS report gates CI; this one answers
the questions a client asks in a review ("where does it fail, what does a ticket cost,
which model is fastest for which kind of ticket?") with plain SQL anyone can extend.

Usage (from the repo root):
    python3 -m venv analysis/.venv && analysis/.venv/bin/pip install -r analysis/requirements.txt
    analysis/.venv/bin/python analysis/eval_analysis.py
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import duckdb
import matplotlib

matplotlib.use("Agg")  # headless: CI and servers have no display
import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "evals" / "results"
OUT = Path(__file__).resolve().parent / "output"

# A model counts as "complete" for comparison once it has scored this share of its cases
# (same rule as evals/report.ts, so both views agree).
COMPLETE_FRACTION = 0.9


@dataclass(frozen=True)
class Totals:
    cases: int
    sample: int
    # Models that run only the fixed sample (evals/cases.ts SAMPLED_MODELS).
    sampled_models: tuple[str, ...] = ()


def latest_version() -> str:
    """The newest prompt version that has results (e.g. agent-v1.3.0)."""
    versions = sorted(p.name for p in RESULTS.iterdir() if p.is_dir())
    if not versions:
        raise SystemExit("no eval results found under evals/results/")
    return versions[-1]


def load_records(version: str) -> pd.DataFrame:
    """
    One row per (model, case) from `cases.ndjson`, the per-case export written by
    `npm run eval:report`. It's re-scored with the current scorer, so this analysis always
    agrees with evals/REPORT.md and the CI gate (reading the raw run records would show the
    older scorer's verdicts).
    """
    path = RESULTS / version / "cases.ndjson"
    if not path.exists():
        raise SystemExit(f"{path} missing: run `npm run eval:report` first")
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        rows.append(
            {
                "model": r["model"],
                "case_id": r["caseId"],
                "category": r["category"],
                "status": r["status"],
                "passed": bool(r["passed"]),
                "outcome": r.get("outcome"),
                "model_ms": r.get("modelLatencyMs") or 0,
                "cost_usd": r.get("costUsd") or 0.0,
                "tokens": r.get("tokens") or 0,
                "failed_checks": ",".join(r.get("failedChecks") or []),
                "policy_failures": r.get("policyFailures") or 0,
                "faithfulness": r.get("judgeFaithfulness"),
            }
        )
    if not rows:
        raise SystemExit(f"no records in {path}")
    return pd.DataFrame(rows)


def analyze(df: pd.DataFrame, totals: Totals) -> dict[str, pd.DataFrame]:
    con = duckdb.connect()
    con.register("runs", df)
    scored = "status = 'scored'"

    by_model = con.execute(
        f"""
        select model,
               count(*) filter (where {scored})                      as scored,
               round(avg(case when passed then 1 else 0 end)
                     filter (where {scored}) * 100, 1)               as pass_rate_pct,
               sum(policy_failures) filter (where {scored})          as safety_failures,
               round(median(model_ms) filter (where {scored}) / 1000, 2) as p50_model_s,
               round(quantile_cont(model_ms, 0.95) filter (where {scored}) / 1000, 2)
                                                                     as p95_model_s,
               round(avg(cost_usd) filter (where {scored}), 5)       as usd_per_ticket,
               round(avg(faithfulness), 2)                           as judge_faithfulness
        from runs group by model order by pass_rate_pct desc nulls last
        """
    ).df()
    target = by_model["model"].map(
        lambda m: totals.sample if m in totals.sampled_models else totals.cases
    )
    by_model["complete"] = by_model["scored"] >= COMPLETE_FRACTION * target

    by_category = con.execute(
        f"""
        select model, category,
               count(*) as cases,
               round(avg(case when passed then 1 else 0 end) * 100, 0) as pass_rate_pct
        from runs where {scored}
        group by model, category order by model, category
        """
    ).df()

    failures = con.execute(
        f"""
        select model, case_id, category, outcome, failed_checks
        from runs where {scored} and not passed
        order by model, category, case_id
        """
    ).df()

    # What would 6,500 tickets a month cost on each model at list price?
    monthly_cost = con.execute(
        f"""
        select model, round(avg(cost_usd) * 6500, 2) as usd_per_6500_tickets
        from runs where {scored} group by model order by usd_per_6500_tickets
        """
    ).df()
    return {
        "by_model": by_model,
        "by_category": by_category,
        "failures": failures,
        "monthly_cost": monthly_cost,
    }


def chart(by_model: pd.DataFrame, path: Path) -> None:
    """Quality vs. latency for complete models: the trade-off a client actually chooses on."""
    done = by_model[by_model["complete"]]
    fig, ax = plt.subplots(figsize=(7, 4.2), dpi=150)
    ax.scatter(done["p50_model_s"], done["pass_rate_pct"], s=120, color="#3b6fd8")
    for _, r in done.iterrows():
        ax.annotate(
            r["model"].split(":")[-1],
            (r["p50_model_s"], r["pass_rate_pct"]),
            textcoords="offset points",
            xytext=(8, 6),
            fontsize=9,
        )
    ax.set_xlabel("Median model time per ticket (s)")
    ax.set_ylabel("Eval cases fully correct (%)")
    ax.set_title("Quality vs. speed (complete models)")
    ax.set_ylim(80, 101)
    ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def to_markdown(df: pd.DataFrame) -> str:
    if df.empty:
        return "_none_"
    cols = list(df.columns)
    lines = ["| " + " | ".join(cols) + " |", "| " + " | ".join("---" for _ in cols) + " |"]
    for _, r in df.iterrows():
        lines.append("| " + " | ".join("" if pd.isna(v) else str(v) for v in r) + " |")
    return "\n".join(lines)


def main() -> None:
    version = latest_version()
    summary = json.loads((RESULTS / version / "summary.json").read_text())
    sampled = tuple(m["model"] for m in summary["models"] if m.get("sampled"))
    sample_size = max((m["target"] for m in summary["models"] if m.get("sampled")), default=15)
    totals = Totals(cases=summary["totalCases"], sample=sample_size, sampled_models=sampled)
    df = load_records(version)
    res = analyze(df, totals)
    OUT.mkdir(parents=True, exist_ok=True)
    chart(res["by_model"], OUT / "quality_vs_speed.png")

    complete = res["by_model"][res["by_model"]["complete"]].drop(columns=["complete"])
    pending = res["by_model"][~res["by_model"]["complete"]][["model", "scored"]]
    complete_models = set(complete["model"])
    report = f"""# Eval analysis (Python + DuckDB SQL), {version}

Generated by `analysis/eval_analysis.py` from `evals/results/{version}/cases.ndjson` (the same re-scored data as `evals/REPORT.md`).
{totals.cases} cases. Models with < {int(COMPLETE_FRACTION * 100)}% of their cases scored are listed as pending.

## Models

{to_markdown(complete)}

Pending (free-tier quota): {", ".join(f"{m} ({n})" for m, n in pending.itertuples(index=False)) or "none"}

![Quality vs. speed](quality_vs_speed.png)

## Model cost at Harbor & Pine volume (6,500 tickets/month, list prices)

{to_markdown(res["monthly_cost"][res["monthly_cost"]["model"].isin(complete_models)])}

## Pass rate by category

{to_markdown(res["by_category"][res["by_category"]["model"].isin(complete_models)])}

## Every failing case (what to fix next)

{to_markdown(res["failures"][res["failures"]["model"].isin(complete_models)])}
"""
    (OUT / "ANALYSIS.md").write_text(report, encoding="utf-8")
    print(f"wrote {OUT / 'ANALYSIS.md'}")


if __name__ == "__main__":
    main()
