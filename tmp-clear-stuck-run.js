require('dotenv').config();
const { Pool } = require('pg');

const RUN_ID = '6f2c9007-c288-40a9-ab58-0bf22e3de931';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const run = await pool.query(
    `update agent_runs
        set status = 'failed',
            terminal_reason = 'worker_lost',
            last_error = 'Apex server crashed mid-run (unhandled CLI stdin error); finalized manually.',
            updated_at = now()
      where id = $1 and status in ('queued','dispatched','running')
      returning id, status, terminal_reason, dev_session_id`,
    [RUN_ID],
  );
  console.log('run updated:', run.rows);

  const sessionId = run.rows[0] && run.rows[0].dev_session_id;
  if (sessionId) {
    const session = await pool.query(
      `update dev_sessions set current_run_id = null, updated_at = now()
        where id = $1 and current_run_id = $2
        returning id`,
      [sessionId, RUN_ID],
    );
    console.log('session cleared:', session.rows);
  }

  const live = await pool.query(
    `select count(*)::int as n from agent_runs where status in ('queued','dispatched','running')`,
  );
  console.log('remaining live runs:', live.rows[0].n);
  await pool.end();
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
