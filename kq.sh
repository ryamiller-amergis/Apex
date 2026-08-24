#!/usr/bin/env bash
# Query App Insights and print rows tab-separated.
# `-o tsv` on this command collapses results to a bare row count, so rows are
# pulled out of the JSON envelope instead.
set -uo pipefail
az monitor app-insights query \
  --app appi-app-scrum-dev -g rg-scrum-dev \
  --analytics-query "$1" \
  -o json 2>&1 \
| node -e "
let raw='';
process.stdin.on('data', c => raw += c);
process.stdin.on('end', () => {
  let d;
  try { d = JSON.parse(raw); }
  catch { console.log(raw.trim().slice(0, 600)); return; }
  const t = (d.tables || [])[0];
  if (!t) { console.log('(no tables)'); return; }
  console.log(t.columns.map(c => c.name).join('\t'));
  console.log('-'.repeat(60));
  for (const r of t.rows) console.log(r.map(v => v == null ? '' : String(v)).join('\t'));
  console.log('-'.repeat(60));
  console.log(t.rows.length + ' row(s)');
});
"
