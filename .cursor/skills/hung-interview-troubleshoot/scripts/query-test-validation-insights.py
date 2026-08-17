#!/usr/bin/env python3
"""App Insights for PRD test-cases + validation after thin/scratch deploy.

Usage:
  python query-test-validation-insights.py --env dev [--minutes 45] [prdId] [threadId...]

Focus events:
  background.route.decision
  background.materialization.outcome   (reason=shared-read-checkout | scratch-only | materialized)
  background.route.fallback
  grounding.materialization.local-reuse
  AiRunsWorkerExecutionFailed (traces/exceptions)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(
    0,
    str(Path(__file__).resolve().parents[2] / "interactive-chat-troubleshoot" / "scripts"),
)
from _lib import assert_az_login, require_env, run_az  # noqa: E402


def parse_rest(rest: list[str]) -> tuple[int, list[str]]:
    minutes = 45
    ids: list[str] = []
    i = 0
    while i < len(rest):
        if rest[i] == "--minutes" and i + 1 < len(rest):
            minutes = int(rest[i + 1])
            i += 2
            continue
        if rest[i].startswith("--minutes="):
            minutes = int(rest[i].split("=", 1)[1])
            i += 1
            continue
        ids.append(rest[i])
        i += 1
    return minutes, ids


def run_query(cfg: dict, label: str, query: str) -> None:
    raw = run_az(
        [
            "monitor",
            "app-insights",
            "query",
            "--app",
            cfg["appInsightsName"],
            "-g",
            cfg["appInsightsResourceGroup"],
            "--analytics-query",
            query,
            "-o",
            "json",
        ]
    )
    print(f"=== {label} ===")
    if not raw:
        print("(none)")
        return
    data = json.loads(raw)
    rows = (data.get("tables") or [{}])[0].get("rows") or []
    if not rows:
        print("(none)")
        return
    for row in rows:
        print(row)


def main() -> None:
    cfg, rest = require_env(sys.argv[1:])
    minutes, ids = parse_rest(rest)
    assert_az_login(cfg.get("subscriptionHint"))

    id_clause = ""
    if ids:
        or_parts = " or ".join(f"tostring(customDimensions) contains '{i}'" for i in ids)
        id_clause = f"| where {or_parts} "

    wf = (
        "customDimensions.workflowClass == 'test-cases' "
        "or customDimensions.workflowClass == 'validation'"
    )

    queries = {
        "route decisions (test-cases|validation)": (
            f"customEvents | where timestamp > ago({minutes}m) "
            f"| where name == 'background.route.decision' "
            f"| where {wf} "
            f"{id_clause}"
            "| project timestamp, name, customDimensions "
            "| order by timestamp asc | take 50"
        ),
        "materialization outcomes": (
            f"customEvents | where timestamp > ago({minutes}m) "
            f"| where name == 'background.materialization.outcome' "
            f"or name == 'grounding.materialization.local-reuse' "
            f"| where {wf} "
            f"{id_clause}"
            "| project timestamp, name, customDimensions "
            "| order by timestamp asc | take 80"
        ),
        "route fallbacks": (
            f"customEvents | where timestamp > ago({minutes}m) "
            f"| where name startswith 'background.route.fallback' "
            f"| where {wf} "
            f"{id_clause}"
            "| project timestamp, name, customDimensions "
            "| order by timestamp asc | take 40"
        ),
        "all background.* for workflow classes": (
            f"customEvents | where timestamp > ago({minutes}m) "
            f"| where name startswith 'background.' "
            f"| where {wf} "
            f"{id_clause}"
            "| project timestamp, name, customDimensions "
            "| order by timestamp asc | take 100"
        ),
        "exceptions mentioning ids / workflow": (
            f"exceptions | where timestamp > ago({minutes}m) "
            "| where "
            + (
                " or ".join(
                    [
                        "outerMessage has 'test-cases'",
                        "outerMessage has 'validation'",
                        "outerMessage has 'Worker execution'",
                        "outerMessage has 'workspace-preparation'",
                    ]
                    + [f"outerMessage has '{i}'" for i in ids]
                    + [f"tostring(customDimensions) has '{i}'" for i in ids]
                )
            )
            + " | project timestamp, type, outerMessage | order by timestamp asc | take 40"
        ),
        "traces (worker / preparation)": (
            f"traces | where timestamp > ago({minutes}m) "
            "| where "
            + (
                " or ".join(
                    [
                        "message has 'testCase'",
                        "message has 'test-cases'",
                        "message has 'autoStartDocumentValidation'",
                        "message has 'AiRunsWorker'",
                        "message has 'scratch-only'",
                        "message has 'shared-read'",
                        "message has 'workspace-preparation'",
                    ]
                    + [f"message has '{i}'" for i in ids]
                )
            )
            + " | project timestamp, severityLevel, message | order by timestamp asc | take 60"
        ),
    }

    if ids:
        needle = " or ".join(f"tostring(customDimensions) contains '{i}'" for i in ids)
        queries["events containing provided ids"] = (
            f"customEvents | where timestamp > ago({minutes}m) "
            f"| where {needle} "
            "| project timestamp, name, customDimensions "
            "| order by timestamp asc | take 80"
        )

    print(f"env={cfg.get('env')} minutes={minutes} ids={ids or '(none — workflowClass filter only)'}")
    for label, query in queries.items():
        run_query(cfg, label, query)


if __name__ == "__main__":
    main()
