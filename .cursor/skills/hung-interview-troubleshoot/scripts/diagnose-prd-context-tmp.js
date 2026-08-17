const { Client } = require('pg');

const prdId = process.argv[2] || '4e5cc83e-a097-4ec4-8275-ca3fddc84b42';

(async () => {
  const c = new Client({
    connectionString: process.env.DEV_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  const prd = await c.query(
    `SELECT id, title, status, interview_id, chat_thread_id, project,
            left(content, 800) AS content_head,
            length(content) AS content_len,
            backlog_json->'epics'->0->>'title' AS epic0_title,
            backlog_json->'epics'->0->'features'->0->>'title' AS feature0_title
     FROM prds WHERE id = $1`,
    [prdId],
  );
  console.log('=== PRD ===');
  console.log(JSON.stringify(prd.rows[0], null, 2));

  const interviewId = prd.rows[0]?.interview_id;
  if (interviewId) {
    const cols = await c.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'interviews' ORDER BY ordinal_position`,
    );
    console.log('interview_cols', cols.rows.map((r) => r.column_name).join(','));

    const i = await c.query(
      `SELECT id, title, status, chat_thread_id, project, repo, model, created_at, updated_at
       FROM interviews WHERE id = $1`,
      [interviewId],
    );
    console.log('=== INTERVIEW ===');
    console.log(JSON.stringify(i.rows[0], null, 2));

    // interview chat messages for topic
    const msgs = await c.query(
      `SELECT role, left(text, 300) AS preview, ts
       FROM chat_messages
       WHERE thread_id = $1
       ORDER BY ts ASC
       LIMIT 12`,
      [i.rows[0].chat_thread_id],
    );
    console.log('=== INTERVIEW MSGS (first) ===');
    console.log(JSON.stringify(msgs, null, 2).slice(0, 5000));
    console.log(JSON.stringify(msgs.rows, null, 2));

    const lastMsgs = await c.query(
      `SELECT role, left(text, 300) AS preview, ts
       FROM chat_messages
       WHERE thread_id = $1
       ORDER BY ts DESC
       LIMIT 8`,
      [i.rows[0].chat_thread_id],
    );
    console.log('=== INTERVIEW MSGS (last) ===');
    console.log(JSON.stringify(lastMsgs.rows, null, 2));
  }

  // PRD kickoff thread
  const threadId = prd.rows[0]?.chat_thread_id;
  if (threadId) {
    const t = await c.query(
      `SELECT id, title, status, grounding_mode, grounded_sha,
              kickoff->>'skillPath' AS skill_path,
              kickoff->>'skillProvider' AS skill_provider,
              kickoff->>'project' AS project,
              kickoff->>'repo' AS repo,
              kickoff->>'branch' AS branch,
              left(coalesce(kickoff->>'transcript',''), 500) AS transcript_head,
              left(coalesce(kickoff->>'freeformContext',''), 500) AS freeform_head,
              jsonb_object_keys_count.kickoff_keys
       FROM chat_threads t
       CROSS JOIN LATERAL (
         SELECT array_agg(k) AS kickoff_keys
         FROM jsonb_object_keys(t.kickoff) AS k
       ) jsonb_object_keys_count
       WHERE id = $1`,
      [threadId],
    ).catch(async (err) => {
      console.log('kickoff query fallback', err.message);
      return c.query(
        `SELECT id, title, status, grounding_mode, grounded_sha,
                kickoff->>'skillPath' AS skill_path,
                kickoff->>'skillProvider' AS skill_provider,
                kickoff->>'project' AS project,
                kickoff->>'repo' AS repo,
                kickoff->>'branch' AS branch,
                left(coalesce(kickoff->>'transcript',''), 800) AS transcript_head,
                left(coalesce(kickoff->>'freeformContext',''), 800) AS freeform_head,
                kickoff
         FROM chat_threads WHERE id = $1`,
        [threadId],
      );
    });
    const row = t.rows[0];
    if (row?.kickoff) {
      row.kickoff_keys = Object.keys(row.kickoff);
      delete row.kickoff;
    }
    console.log('=== PRD THREAD / KICKOFF ===');
    console.log(JSON.stringify(row, null, 2));

    // search content for blackout vs counter
    const hits = await c.query(
      `SELECT
         (content ILIKE '%blackout%') AS mentions_blackout,
         (content ILIKE '%counter%') AS mentions_counter,
         (content ILIKE '%50739%') AS mentions_50739
       FROM prds WHERE id = $1`,
      [prdId],
    );
    console.log('=== CONTENT TOPIC HITS ===');
    console.log(JSON.stringify(hits.rows[0], null, 2));
  }

  await c.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
