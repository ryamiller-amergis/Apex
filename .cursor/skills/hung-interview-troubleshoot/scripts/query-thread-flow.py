#!/usr/bin/env python3
"""Query App Insights for a PRD generation thread flow."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'interactive-chat-troubleshoot' / 'scripts'))
from _lib import assert_az_login, require_env, run_az  # noqa: E402


def main() -> None:
    cfg, rest = require_env(sys.argv[1:])
    thread = rest[0] if rest else ''
    if not thread:
        print('Usage: query-thread-flow.py --env dev <threadId>')
        sys.exit(2)

    assert_az_login(cfg.get('subscriptionHint'))

    queries = {
        'thread events': (
            f"customEvents | where timestamp > ago(15m) "
            f"| where tostring(customDimensions) contains '{thread}' "
            "| project timestamp, name, customDimensions "
            "| order by timestamp asc"
        ),
        'prd maxview flow': (
            "customEvents | where timestamp > ago(15m) "
            "| where name in ('grounding.repository.preparation',"
            "'grounding.materialization.local-reuse',"
            "'grounding.materialization.fallback',"
            "'grounding.materialization.exact-fetch',"
            "'background.materialization.outcome',"
            "'background.route.fallback',"
            "'background.route.decision',"
            "'chat.send.start',"
            "'chat.send.interactive_result') "
            f"| where customDimensions.project == 'MaxView' "
            f"or tostring(customDimensions) contains '{thread}' "
            "| project timestamp, name, customDimensions "
            "| order by timestamp asc"
        ),
    }

    for label, query in queries.items():
        raw = run_az([
            'monitor', 'app-insights', 'query',
            '--app', cfg['appInsightsName'],
            '-g', cfg['appInsightsResourceGroup'],
            '--analytics-query', query,
            '-o', 'json',
        ])
        data = json.loads(raw)
        rows = (data.get('tables') or [{}])[0].get('rows') or []
        print(f'=== {label} ({len(rows)}) ===')
        for ts, name, dims in rows:
            print(f'{ts}  {name}')
            if dims:
                print(f'  {dims[:500]}')


if __name__ == '__main__':
    main()
