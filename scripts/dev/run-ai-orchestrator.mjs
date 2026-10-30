#!/usr/bin/env node
// Drains the local AI-run outbox and posts interactive turns to the actor host.
// The host is a separate process (scripts/dev/run-interactive-host.mjs). This
// process does not consume Azure Service Bus; local turns are delivered by HTTP.

import 'dotenv/config';
import { spawn } from 'node:child_process';

const dispatchUrl = (process.env.AI_RUNS_INTERACTIVE_DISPATCH_URL || '').trim();
const fastUrl = (process.env.AI_RUNS_INTERACTIVE_FAST_DISPATCH_URL || '').trim();
const agenticUrl = (process.env.AI_RUNS_INTERACTIVE_AGENTIC_DISPATCH_URL || '').trim();

if (!dispatchUrl && !fastUrl && !agenticUrl) {
  console.error(
    'Set AI_RUNS_INTERACTIVE_DISPATCH_URL so local interactive turns have a host to call.',
  );
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [
    '-r',
    'dotenv/config',
    '-r',
    'ts-node/register',
    'src/server/services/aiOrchestrator/entrypoint.ts',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      TS_NODE_PROJECT: 'tsconfig.server.json',
      AI_ORCHESTRATOR_SB_MODE: 'noop',
      AI_RUNS_INTERACTIVE_FAST_DISPATCH_URL: fastUrl || dispatchUrl,
      AI_RUNS_INTERACTIVE_AGENTIC_DISPATCH_URL: agenticUrl || dispatchUrl,
    },
  },
);

const stop = () => {
  if (!child.killed) child.kill();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
