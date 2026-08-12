#!/usr/bin/env python3
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'interactive-chat-troubleshoot' / 'scripts'))
from _lib import assert_az_login, require_env, run_az  # noqa: E402

cfg, rest = require_env(sys.argv[1:])
prd_id = rest[0] if rest else '762e88a7-bc46-4e4f-b687-15bc85f135ca'
thread_id = rest[1] if len(rest) > 1 else 'c9f7e40a-1b5a-4ee4-b645-b9452186ba95'

assert_az_login(cfg.get('subscriptionHint'))

queries = {
    'prd events': (
        "customEvents | where timestamp > ago(2h) "
        f"| where tostring(customDimensions) contains '{prd_id}' "
        "| project timestamp, name, customDimensions | order by timestamp asc"
    ),
    'thread events': (
        "customEvents | where timestamp > ago(2h) "
        f"| where tostring(customDimensions) contains '{thread_id}' "
        "| project timestamp, name, customDimensions | order by timestamp asc"
    ),
    'background prd maxview': (
        "customEvents | where timestamp > ago(2h) "
        "| where name startswith 'background.' "
        "| where customDimensions.workflowClass == 'prd' or customDimensions.project == 'MaxView' "
        "| project timestamp, name, customDimensions | order by timestamp asc | take 30"
    ),
    'chat send maxview': (
        "customEvents | where timestamp between(datetime(2026-08-12T05:40:00Z), datetime(2026-08-12T05:42:00Z)) "
        "| where name startswith 'chat.send' or name startswith 'background.' "
        "| project timestamp, name, customDimensions | order by timestamp asc"
    ),
    'exceptions': (
        "exceptions | where timestamp > ago(2h) "
        f"| where tostring(customDimensions) contains '{prd_id}' "
        f"or outerMessage contains '{prd_id}' "
        "| project timestamp, type, outerMessage | order by timestamp asc | take 20"
    ),
    'traces': (
        "traces | where timestamp > ago(2h) "
        f"| where message contains '{prd_id}' or message contains '{thread_id}' "
        "| project timestamp, severityLevel, message | order by timestamp asc | take 30"
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
    print(f'=== {label} ===')
    if not raw:
        print('(none)')
        continue
    data = json.loads(raw)
    rows = (data.get('tables') or [{}])[0].get('rows') or []
    if not rows:
        print('(none)')
    for row in rows:
        print(row)
