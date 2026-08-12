#!/usr/bin/env node
const { Client } = require('pg');

async function main() {
  const c = new Client({
    connectionString: process.env.DEV_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  const tcs = await c.query(
    `SELECT id, prd_id, chat_thread_id, status, length(content::text) AS content_len,
            updated_at, created_at
     FROM test_cases
     WHERE prd_id = 'b6528478-2e79-4489-a0cf-82c7c71d3ff7'
     ORDER BY created_at DESC`,
  );
  console.log('=== TEST CASES ===');
  console.log(JSON.stringify(tcs.rows, null, 2));

  // check messages on latest test threads
  for (const tid of [
    '50b2b59e-56d4-4863-946d-262b03e7e799',
    '455e1c5b-d956-45e1-af5e-230530155876',
  ]) {
    const msgs = await c.query(
      `SELECT role, left(coalesce(content, ''), 200) AS content, created_at
       FROM chat_messages
       WHERE thread_id = $1
       ORDER BY created_at DESC
       LIMIT 5`,
      [tid],
    ).catch(async (e) => {
      // try alternate schema
      const cols = await c.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name='chat_messages'`,
      );
      console.log('chat_messages cols', cols.rows.map((r) => r.column_name).join(','));
      throw e;
    });
    console.log('=== MSGS', tid, '===');
    console.log(JSON.stringify(msgs.rows, null, 2));
  }

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
