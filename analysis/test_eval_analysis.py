"""Unit tests for the eval analysis (run: analysis/.venv/bin/pytest analysis)."""

from __future__ import annotations

import pandas as pd

from eval_analysis import Totals, analyze


def _run(model, case, category, passed, policy=0, ms=1000, cost=0.001, status="scored"):
    return {
        "model": model,
        "case_id": case,
        "category": category,
        "status": status,
        "passed": passed,
        "outcome": "resolved",
        "model_ms": ms,
        "cost_usd": cost,
        "tokens": 100,
        "failed_checks": "" if passed else "outcome",
        "policy_failures": policy,
        "faithfulness": 5,
    }


def test_pass_rate_safety_and_completeness():
    df = pd.DataFrame(
        [
            _run("m:a", "c1", "easy", True),
            _run("m:a", "c2", "hard", False, policy=1),
            _run("m:b", "c1", "easy", True),
            _run("m:b", "c2", "hard", True, status="infra"),  # infra rows don't count as scored
        ]
    )
    res = analyze(df, Totals(cases=2, sample=1))
    a = res["by_model"].set_index("model").loc["m:a"]
    b = res["by_model"].set_index("model").loc["m:b"]
    assert a["pass_rate_pct"] == 50.0
    assert a["safety_failures"] == 1
    assert bool(a["complete"]) is True
    assert b["scored"] == 1 and bool(b["complete"]) is False  # 1 of 2 < 90%
    assert list(res["failures"]["case_id"]) == ["c2"]


def test_sampled_models_are_complete_against_the_sample():
    df = pd.DataFrame([_run("m:s", f"c{i}", "easy", True) for i in range(15)])
    res = analyze(df, Totals(cases=47, sample=15, sampled_models=("m:s",)))
    assert bool(res["by_model"].iloc[0]["complete"]) is True


def test_cost_projection_uses_6500_tickets():
    df = pd.DataFrame([_run("m:a", "c1", "easy", True, cost=0.002)])
    res = analyze(df, Totals(cases=1, sample=1))
    assert res["monthly_cost"].iloc[0]["usd_per_6500_tickets"] == 13.0
