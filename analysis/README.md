# Eval analysis (Python + SQL)

A second look at the eval results, written in Python with **DuckDB SQL** over the per-case export (`evals/results/<version>/cases.ndjson`, produced by `npm run eval:report` with the current scorer, so the numbers always match [evals/REPORT.md](../evals/REPORT.md)).

It answers the questions a client asks in a quality review:

- Which model is fastest for the quality we need?
- What would 6,500 tickets a month cost on each model?
- Which ticket categories fail, and which exact cases should be fixed next?

**Output:** [output/ANALYSIS.md](output/ANALYSIS.md) and [output/quality_vs_speed.png](output/quality_vs_speed.png).

```bash
python3 -m venv analysis/.venv
analysis/.venv/bin/pip install -r analysis/requirements.txt
analysis/.venv/bin/pytest -q analysis
analysis/.venv/bin/python analysis/eval_analysis.py
```

CI runs the tests and the analysis on every pull request (`python-analysis` job).
