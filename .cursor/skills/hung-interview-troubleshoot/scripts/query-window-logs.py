#!/usr/bin/env python3
"""Query App Insights traces + exceptions over the last N minutes with an
optional keyword filter. Read-only.

Usage:
  python query-window-logs.py --env dev --minutes 20 \
      --contains prd,background.,kickoff,grounding
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'interactive-chat-troubleshoot' / 'scripts'))
from _lib import assert_az_login, require_env, run_az  # noqa: E402


def kusto(cfg, query):
    raw = run_az([
        'monitor', 'app-insights', 'query',
        '--app', cfg['appInsightsName'],
        '-g', cfg['appInsightsResourceGroup'],
        '--analytics-query', query,
        '-o', 'json',
    ])
    if not raw:
        return []
    data = json.loads(raw)
    tables = data.get('tables') or []
    return tables[0].get('rows') if tables else []


def main() -> None:
    cfg, rest = require_env(sys.argv[1:])
    parser = argparse.ArgumentParser()
    parser.add_argument('--minutes', type=int, default=20)
    parser.add_argument('--contains', default='')
    parser.add_argument('--take', type=int, default=200)
    args = parser.parse_args(rest)

    assert_az_login(cfg.get('subscriptionHint'))

    terms = [t.strip() for t in args.contains.split(',') if t.strip()]
    term_list = ','.join(f"'{t}'" for t in terms)

    trace_filter = f"| where message has_any({term_list}) " if terms else ''
    exc_filter = f"| where outerMessage has_any({term_list}) or innermostMessage has_any({term_list}) " if terms else ''

    print(f'=== TRACES (last {args.minutes}m) ===')
    trace_q = (
        f"traces | where timestamp > ago({args.minutes}m) "
        f"{trace_filter}"
        f"| project timestamp, severityLevel, message "
        f"| order by timestamp asc | take {args.take}"
    )
    rows = kusto(cfg, trace_q)
    print(f'rows: {len(rows)}')
    for row in rows:
        print('  '.join('' if v is None else str(v) for v in row))

    print(f'\n=== EXCEPTIONS (last {args.minutes}m) ===')
    exc_q = (
        f"exceptions | where timestamp > ago({args.minutes}m) "
        f"{exc_filter}"
        f"| project timestamp, type, outerMessage, innermostMessage, method=operation_Name "
        f"| order by timestamp asc | take {args.take}"
    )
    rows = kusto(cfg, exc_q)
    print(f'rows: {len(rows)}')
    for row in rows:
        print('  |  '.join('' if v is None else str(v) for v in row))


if __name__ == '__main__':
    main()
