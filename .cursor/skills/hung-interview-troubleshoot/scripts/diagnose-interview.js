#!/usr/bin/env node
/**
 * Diagnose a hung Apex interview from prod (or any) Postgres.
 *
 * Usage:
 *   set PROD_DATABASE_URL / DATABASE_URL, then:
 *   node .cursor/skills/hung-interview-troubleshoot/scripts/diagnose-interview.js <interviewId>
 *
 * Never logs the connection string.
 */
const { Client } = require('pg');

const interviewId = process.argv[2];
if (!interviewId || !/^[0-9a-f-]{36}$/i.test(interviewId)) {
  console.error('Usage: node diagnose-interview.js <interviewUuid>');
  process.exit(2);
}

const connectionString = process.env.PROD_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Set PROD_DATABASE_URL or DATABASE_URL');
  process.exit(2);
}

function age(seconds) {
  if (seconds == null) return 'n/a';
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function toolAgeSeconds(lastTool) {
  if (!lastTool?.event_timestamp) return null;
  const ms = Date.now() - Date.parse(lastTool.event_timestamp);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : null;
}

function classify({ thread, run, lastTool }) {
  if (!thread) return { verdict: 'missing', detail: 'Interview not found' };
  if (thread.status === 'idle' && (!run || ['completed', 'failed', 'cancelled'].includes(run.status))) {
    return { verdict: 'healthy', detail: 'Thread idle; no active run' };
  }
  if (!run || !['running', 'queued'].includes(run.status)) {
    if (thread.status === 'running') {
      return { verdict: 'hung', mode: 'C', detail: 'Thread running with no live agent_runs row' };
    }
    return { verdict: 'healthy', detail: 'No active hang signals' };
  }
  if (run.status === 'queued' && run.run_age_s >= 90) {
    return { verdict: 'hung', mode: 'B', detail: 'Run queued too long (never claimed)' };
  }
  if (run.heartbeat_age_s >= 300) {
    return { verdict: 'hung', mode: 'B', detail: 'Worker heartbeat expired' };
  }

  // Prefer tool-event age over progress_at — deployed versions may refresh
  // progress while any tool is wedged, making a stalled tool look healthy.
  const toolRunning = lastTool && lastTool.status === 'running';
  const toolAgeS = toolAgeSeconds(lastTool);
  const label = `${run.progress_label || ''} ${lastTool?.detail || ''}`;
  if (toolRunning && /\brunning\b/i.test(label)) {
    const isMcpTool = /^mcp:/i.test(lastTool.detail || '');
    const mode = isMcpTool ? 'A' : 'E';
    if (toolAgeS != null && toolAgeS >= 90) {
      return {
        verdict: 'hung',
        mode,
        detail: `Hung ${isMcpTool ? 'MCP' : 'non-MCP'} tool for ${age(toolAgeS)}: ${lastTool.detail || run.progress_label}`,
      };
    }
    return {
      verdict: 'watch',
      mode: `${mode}?`,
      detail: `Tool in flight (${lastTool.detail || run.progress_label}, ${age(toolAgeS)}); wait up to ~90s`,
    };
  }
  if (run.progress_age_s >= 300) {
    return { verdict: 'hung', mode: 'B', detail: 'No meaningful progress >5m' };
  }
  if (run.heartbeat_age_s <= 30 && run.progress_age_s <= 60) {
    return { verdict: 'false_alarm', mode: 'D', detail: 'Fresh heartbeat/progress — still working' };
  }
  return { verdict: 'watch', detail: 'Running but not yet past hang thresholds' };
}

(async () => {
  const c = new Client({
    connectionString,
    ssl: connectionString.includes('localhost') ? undefined : { rejectUnauthorized: false },
  });
  await c.connect();

  const interviewRes = await c.query(
    `SELECT id, title, status, project, chat_thread_id, model, created_at, updated_at
     FROM interviews WHERE id = $1`,
    [interviewId],
  );
  const interview = interviewRes.rows[0];
  if (!interview) {
    console.log(JSON.stringify({ verdict: 'missing', interviewId }, null, 2));
    await c.end();
    process.exit(1);
  }
  const threadId = interview.chat_thread_id;

  const threadRes = await c.query(
    `SELECT id, status, active_run_id,
            left(coalesce(last_error,''), 500) AS last_error,
            workspace_dir, cursor_agent_id, title,
            created_at, last_activity_at,
            kickoff->>'model' AS kickoff_model,
            kickoff->>'skillPath' AS kickoff_skill,
            kickoff->>'skillProvider' AS kickoff_provider,
            kickoff->>'repo' AS kickoff_repo,
            EXTRACT(EPOCH FROM (now() - last_activity_at))::int AS idle_s
     FROM chat_threads WHERE id = $1`,
    [threadId],
  );
  const thread = threadRes.rows[0];

  const runsRes = await c.query(
    `SELECT id, status, owner_instance, heartbeat_at, progress_at, progress_label, progress_phase,
            started_at, created_at, updated_at, timeout_at,
            left(coalesce(last_error,''), 500) AS last_error,
            EXTRACT(EPOCH FROM (now() - coalesce(heartbeat_at, created_at)))::int AS heartbeat_age_s,
            EXTRACT(EPOCH FROM (now() - coalesce(progress_at, started_at, created_at)))::int AS progress_age_s,
            EXTRACT(EPOCH FROM (now() - coalesce(started_at, created_at)))::int AS run_age_s
     FROM agent_runs
     WHERE thread_id = $1
     ORDER BY created_at DESC
     LIMIT 8`,
    [threadId],
  );
  const runs = runsRes.rows;
  const active =
    runs.find((r) => r.id === thread.active_run_id) ||
    runs.find((r) => r.status === 'running' || r.status === 'queued') ||
    runs[0];

  let lastTool = null;
  let recentEvents = [];
  if (active) {
    const toolRes = await c.query(
      `SELECT event_type, status, left(coalesce(detail,''), 200) AS detail, event_timestamp, sequence
       FROM agent_run_events
       WHERE run_id = $1 AND event_type = 'tool'
       ORDER BY ordinal DESC LIMIT 5`,
      [active.id],
    );
    lastTool = toolRes.rows[0] || null;

    const evRes = await c.query(
      `SELECT event_type, phase, status, left(coalesce(detail,''), 160) AS detail, event_timestamp
       FROM agent_run_events WHERE run_id = $1
       ORDER BY ordinal DESC LIMIT 12`,
      [active.id],
    );
    recentEvents = evRes.rows;
  }

  const msgRes = await c.query(
    `SELECT role, left(text, 220) AS preview, ts
     FROM chat_messages WHERE thread_id = $1
     ORDER BY ts DESC LIMIT 6`,
    [threadId],
  );

  const restartRes = await c.query(
    `SELECT role, left(text, 160) AS preview, ts
     FROM chat_messages
     WHERE thread_id = $1
       AND (
         text ILIKE '%mandatory pre-read%' OR text ILIKE '%scratch folder%'
         OR text ILIKE '%lost the context%' OR text ILIKE '%I''ll start by%'
       )
     ORDER BY ts DESC LIMIT 5`,
    [threadId],
  );

  const classification = classify({ thread, run: active, lastTool });

  const report = {
    classifiedAt: new Date().toISOString(),
    verdict: classification.verdict,
    mode: classification.mode || null,
    detail: classification.detail,
    interview: {
      id: interview.id,
      title: interview.title,
      status: interview.status,
      project: interview.project,
      model: interview.model,
    },
    thread: {
      id: thread.id,
      status: thread.status,
      active_run_id: thread.active_run_id,
      last_error: thread.last_error,
      kickoff_skill: thread.kickoff_skill,
      kickoff_provider: thread.kickoff_provider,
      idle: age(thread.idle_s),
      last_activity_at: thread.last_activity_at,
    },
    activeRun: active
      ? {
          id: active.id,
          status: active.status,
          progress_label: active.progress_label,
          progress_phase: active.progress_phase,
          last_error: active.last_error,
          heartbeat_age: age(active.heartbeat_age_s),
          progress_age: age(active.progress_age_s),
          run_age: age(active.run_age_s),
          owner_instance: active.owner_instance,
        }
      : null,
    lastTool: lastTool
      ? { ...lastTool, tool_age: age(toolAgeSeconds(lastTool)) }
      : null,
    recentEvents,
    recentMessages: msgRes.rows,
    contextLossHints: restartRes.rows,
    recentRuns: runs.map((r) => ({
      id: r.id,
      status: r.status,
      progress_label: r.progress_label,
      last_error: r.last_error,
      run_age: age(r.run_age_s),
      started_at: r.started_at,
    })),
  };

  console.log(JSON.stringify(report, null, 2));
  await c.end();
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
