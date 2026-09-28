#!/usr/bin/env node
// Turns Cursor CLI stream-json into short APEX_ACTIVITY lines.
// File contents, command output, and the user prompt stay out of the job log.
import fs from 'fs';
import readline from 'readline';

const summaryPath = process.argv[2];
let assistantCount = 0;
let summary = '';

// stdout is a pipe inside the job, so Node holds writes until the buffer fills
// or the agent exits. Flush each line or the activity panel stays on "Connecting".
const stdoutHandle = process.stdout._handle;
if (stdoutHandle && typeof stdoutHandle.setBlocking === 'function') {
  stdoutHandle.setBlocking(true);
}

const TITLES = {
  readToolCall: 'Read file',
  writeToolCall: 'Write file',
  editToolCall: 'Edit file',
  deleteToolCall: 'Delete file',
  shellToolCall: 'Run command',
  bashToolCall: 'Run command',
  grepToolCall: 'Search',
  globToolCall: 'Find files',
  lsToolCall: 'List files',
  todoToolCall: 'Update tasks',
};

function clip(value, max) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function emit(event) {
  if (!event.detail) delete event.detail;
  process.stdout.write(`APEX_ACTIVITY ${JSON.stringify(event)}\n`);
}

function toolKey(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return 'tool';
  return Object.keys(toolCall)[0] || 'tool';
}

function toolDetail(name, body) {
  if (name === 'function') return clip(body?.name || body?.args?.name, 160);
  const args = body?.args ?? {};
  return clip(
    args.path || args.file_path || args.target_file || args.command || args.cmd || args.pattern || args.glob || args.query || '',
    200,
  );
}

function handle(event) {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'user') return;
  if (event.type === 'system' && event.subtype === 'init') {
    emit({
      id: 'init',
      kind: 'status',
      title: 'Agent started',
      detail: clip(event.model, 80),
      status: 'running',
    });
    return;
  }
  if (event.type === 'assistant') {
    const parts = Array.isArray(event.message?.content) ? event.message.content : [];
    const text = parts.filter((part) => part?.type === 'text').map((part) => part.text).join('\n');
    const detail = clip(text, 500);
    if (!detail) return;
    assistantCount += 1;
    emit({
      id: `assistant:${assistantCount}`,
      kind: 'assistant',
      title: 'Agent',
      detail,
      status: 'completed',
    });
    return;
  }
  if (event.type === 'tool_call') {
    const name = toolKey(event.tool_call);
    const body = event.tool_call?.[name] ?? {};
    const failed = event.subtype === 'completed' && body.result && !body.result.success;
    emit({
      id: `tool:${event.call_id || assistantCount}:${event.subtype || 'started'}`,
      kind: name === 'todoToolCall' ? 'task' : 'tool',
      title: TITLES[name] || (name === 'function' ? clip(body?.name, 80) || 'Tool' : 'Tool'),
      detail: toolDetail(name, body),
      status: event.subtype === 'completed' ? (failed ? 'failed' : 'completed') : 'running',
    });
    return;
  }
  if (event.type === 'result') {
    summary = typeof event.result === 'string' ? event.result : '';
    emit({
      id: 'result',
      kind: 'status',
      title: event.is_error ? 'Agent failed' : 'Agent finished',
      status: event.is_error ? 'failed' : 'completed',
    });
  }
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) continue;
  try {
    handle(JSON.parse(trimmed));
  } catch {
    // Ignore a partial line.
  }
}

if (summaryPath) {
  fs.writeFileSync(summaryPath, clip(summary, 2000));
}
