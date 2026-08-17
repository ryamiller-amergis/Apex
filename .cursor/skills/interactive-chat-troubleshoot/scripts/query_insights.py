#!/usr/bin/env python3
"""
Query App Insights for interactive-route / dispatch / live-bus style customEvents.

Uses: az monitor app-insights query
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lib import assert_az_login, require_env, run_az  # noqa: E402


def run_kusto(cfg: dict, query: str) -> list[list]:
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
    if not raw:
        return []
    data = json.loads(raw)
    tables = data.get("tables") or []
    if not tables:
        return []
    return tables[0].get("rows") or []


def main() -> None:
    cfg, rest = require_env(sys.argv[1:])
    parser = argparse.ArgumentParser()
    parser.add_argument("--hours", type=float, default=2.0)
    parser.add_argument("--thread", default=None)
    args = parser.parse_args(rest)

    assert_az_login(cfg.get("subscriptionHint"))
    hours = args.hours
    thread = (args.thread or "").strip()

    print(f"=== event name histogram ({hours}h) @ {cfg['appInsightsName']} ===")
    hist = run_kusto(
        cfg,
        f"customEvents | where timestamp > ago({hours}h) "
        f"| summarize count() by name | order by count_ desc | take 25",
    )
    for row in hist:
        print(f"{row[0]:<45} {row[1]}")

    print()
    print("=== interactive route / dispatch / live-bus events ===")
    filt = (
        "customEvents "
        f"| where timestamp > ago({hours}h) "
        "| where name has_any ('interactive.', 'chat.messages', 'chat.send', "
        "'InteractiveLiveBus', 'grounding.fallback', 'native-read') "
    )
    if thread:
        filt += f"| where tostring(customDimensions) has '{thread}' "
    filt += "| project timestamp, name, customDimensions | order by timestamp desc | take 40"
    rows = run_kusto(cfg, filt)
    if not rows:
        print("(none — if flag is on and users are chatting, this may indicate early-gate / no router)")
    for row in rows:
        dims = row[2]
        if isinstance(dims, str) and len(dims) > 200:
            dims = dims[:200] + "…"
        print(f"{row[0]}  {row[1]}  {dims}")


if __name__ == "__main__":
    main()
