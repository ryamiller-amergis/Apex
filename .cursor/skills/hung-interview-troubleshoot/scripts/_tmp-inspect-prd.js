#!/usr/bin/env node
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ENV_PATH = path.join(
  __dirname,
  '..',
  '..',
  'interactive-chat-troubleshoot',
  'environments.json',
);

function fetchDatabaseUrl(envKey) {
  const data = JSON.parse(fs.readFileSync(ENV_PATH, 'utf8'));
  const cfg = data.envs[envKey];
  const r = spawnSync(
    'az',
    [
      'webapp', 'config', 'appsettings', 'list',
      '--name', cfg.appName,
      '--resource-group', cfg.appResourceGroup,
      '--query', "[?name=='DATABASE_URL'].value",
      '-o', 'tsv',
    ],
    { encoding: 'utf8', shell: process.platform === 'win32' },
  );
  const url = (r.stdout || '').trim();
  if (!url || !url.startsWith('postgres')) {
    throw new Error(`Failed to fetch DATABASE_URL: ${r.stderr}`);
  }
  return url;
}

async function main() {
  const prdId = process.argv[2] || 'b786e410-8e5b-4ef9-bbe4-405d2bed1147';
  const c = new Client({
    connectionString: fetchDatabaseUrl('dev'),
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  const stories = await c.query(
    `SELECT item->>'id' AS id,
            item->>'title' AS title,
            item->>'description' AS description,
            item->'userStory' AS user_story,
            jsonb_typeof(item->'userStory') AS us_type
     FROM prds,
          LATERAL jsonb_array_elements(COALESCE(backlog_json->'epics', '[]'::jsonb)) epic,
          LATERAL jsonb_array_elements(COALESCE(epic->'features', '[]'::jsonb)) feat,
          LATERAL jsonb_array_elements(COALESCE(feat->'items', '[]'::jsonb)) item
     WHERE prds.id = $1
       AND item->>'type' = 'PBI'`,
    [prdId],
  );
  console.log('=== PBI USER STORIES ===');
  console.log(JSON.stringify(stories.rows, null, 2));

  const msgs = await c.query(
    `SELECT role, length(text) AS len, text, ts
     FROM chat_messages
     WHERE thread_id = '76b3381c-a130-4234-aa15-8caf16f4ff4c'
     ORDER BY ts ASC`,
  );
  console.log('=== TEST-CASE MESSAGES ===');
  for (const m of msgs.rows) {
    console.log(JSON.stringify({ role: m.role, ts: m.ts, len: m.len, text: m.text }, null, 2));
  }

  const failedRun = await c.query(
    `SELECT id, status, last_error, progress_label, progress_phase, lane,
            left(execution_snapshot::text, 1500) AS snapshot_preview
     FROM agent_runs
     WHERE id = '76b3381c-a130-4234-aa15-8caf16f4ff4c'`,
  );
  console.log('=== FAILED RUN SNAPSHOT ===');
  console.log(JSON.stringify(failedRun.rows[0], null, 2));

  const completedMsgs = await c.query(
    `SELECT event_type, status, left(detail::text, 300) AS detail, event_timestamp
     FROM agent_run_events
     WHERE run_id = 'run-4be932a3-a760-452d-ad6a-45618efefd6f'
     ORDER BY ordinal ASC
     LIMIT 40`,
  );
  console.log('=== COMPLETED RUN EVENTS ===');
  console.log(JSON.stringify(completedMsgs.rows, null, 2));

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
