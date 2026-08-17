#!/usr/bin/env python3
"""Dump App Insights customEvents over the last N minutes, optionally filtered
by an event-name prefix list. Read-only.

Usage:
  python query-custom-events.py --env dev --minutes 20 \
      --names background.,chat.send,grounding.,agent_run
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'interactive-chat-troubleshoot' / 'scripts'))
from _lib import assert_az_login, require_env, run_az  # noqa: E402


def main() -> None:
    cfg, rest = require_env(sys.argv[1:])
    parser = argparse.ArgumentParser()
    parser.add_argument('--minutes', type=int, default=20)
    parser.add_argument('--names', default='')
    parser.add_argument('--take', type=int, default=300)
    args = parser.parse_args(rest)

    assert_az_login(cfg.get('subscriptionHint'))

    names = [n.strip() for n in args.names.split(',') if n.strip()]
    if names:
        clause = ' or '.join(f"name startswith '{n}'" for n in names)
        filt = f"| where {clause} "
    else:
        filt = ''

    query = (
        f"customEvents | where timestamp > ago({args.minutes}m) "
        f"{filt}"
        "| project timestamp, name, customDimensions "
        f"| order by timestamp asc | take {args.take}"
    )

    raw = run_az([
        'monitor', 'app-insights', 'query',
        '--app', cfg['appInsightsName'],
        '-g', cfg['appInsightsResourceGroup'],
        '--analytics-query', query,
        '-o', 'json',
    ])
    if not raw:
        print('(no result)')
        return
    data = json.loads(raw)
    rows = (data.get('tables') or [{}])[0].get('rows') or []
    print(f'rows: {len(rows)}')
    for row in rows:
        print('  '.join('' if v is None else str(v) for v in row))


if __name__ == '__main__':
    main()
