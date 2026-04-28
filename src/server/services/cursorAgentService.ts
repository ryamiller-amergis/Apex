import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';

const WORKSPACE_ROOT = path.resolve(__dirname, '../../..');
const AGENT_LOG_FILE = path.join(WORKSPACE_ROOT, 'cursor-agent.log');

/**
 * On Windows the agent ships as agent.cmd → cursor-agent.ps1 → node.exe.
 * Spawning .cmd with shell:true causes cmd.exe to mangle any < > " & in the
 * prompt string before Node ever sees it.  We bypass the wrapper entirely and
 * call node.exe + index.js directly, which lets Node handle the args array
 * safely without any shell escaping.
 */
interface AgentExecutable {
  executable: string;  // path to node.exe (Win) or the agent binary (Unix)
  scriptArg?: string;  // path to index.js — only needed on Windows
}

function resolveAgentExecutable(): AgentExecutable {
  if (process.platform === 'win32') {
    const agentBase = path.join(os.homedir(), 'AppData', 'Local', 'cursor-agent');
    const versionsDir = path.join(agentBase, 'versions');

    // Pick the newest version directory (YYYY.MM.DD-hash format)
    let chosenVersion: string | null = null;
    try {
      const entries = fs.readdirSync(versionsDir);
      const versions = entries.filter(e => /^\d{4}\.\d+\.\d+-[a-f0-9]+$/.test(e)).sort().reverse();
      chosenVersion = versions[0] ?? null;
    } catch { /* fall through */ }

    if (chosenVersion) {
      const versionDir = path.join(versionsDir, chosenVersion);
      const nodeExe  = path.join(versionDir, 'node.exe');
      const indexJs  = path.join(versionDir, 'index.js');
      if (fs.existsSync(nodeExe) && fs.existsSync(indexJs)) {
        return { executable: nodeExe, scriptArg: indexJs };
      }
    }

    // Fallback: try the agent.cmd wrapper (may fail on long prompts)
    return { executable: path.join(agentBase, 'agent.cmd') };
  }

  // macOS / Linux
  const unixDefault = path.join(os.homedir(), '.cursor', 'bin', 'agent');
  if (fs.existsSync(unixDefault)) return { executable: unixDefault };
  return { executable: 'agent' };
}

/**
 * Builds the prompt sent to the Cursor headless agent for a single Figma export.
 * The agent has access to the Figma MCP plugin configured in Cursor.
 */
function buildFigmaExportPrompt(item: {
  featureId: string;
  featureTitle: string;
  pagePath: string;
  mockHtmlUrl: string;
}): string {
  return `You are running a silent background task. Do not ask questions — complete the task automatically.

Task: Create a Figma design for an approved UI mock and save the URL back to the backlog.

## Step 1 — Create the Figma design

Use generate_figma_design to capture this URL into the MaxView UX Figma file:
- URL to capture: ${item.mockHtmlUrl}
- outputMode: existingFile
- fileKey: ZsL1t2zBbuBCQDwgVHCvEO (MaxView UX mocks Figma file)
- Page name: ${item.featureTitle}

Call generate_figma_design with no arguments first to get instructions, then call it with the parameters above.
Poll every 5 seconds with the returned captureId until status = 'completed'.
The completed response contains the Figma page URL.

## Step 2 — Save the URL back

POST http://localhost:3001/api/backlog/update-figma-url
Content-Type: application/json

{
  "featureId": "${item.featureId}",
  "pagePath": "${item.pagePath}",
  "figmaUrl": "<the Figma page URL from Step 1>",
  "project": "MaxView",
  "areaPath": "MaxView"
}

If Step 1 fails for any reason, POST to:
http://localhost:3001/api/backlog/update-figma-url
with figmaUrl set to null and include an "error" field describing what went wrong.

Complete both steps, then output: DONE`;
}

export interface FigmaExportJobResult {
  success: boolean;
  figmaUrl?: string;
  error?: string;
}

/**
 * Spawns the Cursor CLI agent headlessly to create a Figma design for an
 * approved UI mock. Returns a promise that resolves when the agent finishes.
 *
 * Requires the `agent` CLI to be installed (ships with Cursor >= Feb 2026)
 * and CURSOR_API_KEY set in the environment.
 */
export async function triggerFigmaExportViaAgent(item: {
  featureId: string;
  featureTitle: string;
  pagePath: string;
  mockHtmlUrl: string;
}): Promise<FigmaExportJobResult> {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    return { success: false, error: 'CURSOR_API_KEY is not set in .env' };
  }

  const prompt = buildFigmaExportPrompt(item);

  return new Promise((resolve) => {
    const { executable, scriptArg } = resolveAgentExecutable();
    const cliArgs = [
      ...(scriptArg ? [scriptArg] : []),
      '--print', '--force', '--approve-mcps', '--output-format', 'text',
      prompt,
    ];
    const logHeader = `\n${'='.repeat(60)}\n[${new Date().toISOString()}] Starting agent for: ${item.featureTitle}\n${'='.repeat(60)}\n`;
    fs.appendFileSync(AGENT_LOG_FILE, logHeader);
    console.log(`[cursorAgent] Spawning agent: ${executable} (scriptArg=${scriptArg ?? 'none'}) — tailing: ${AGENT_LOG_FILE}`);

    const child = spawn(
      executable,
      cliArgs,
      {
        cwd: WORKSPACE_ROOT,
        env: {
          ...process.env,
          CURSOR_API_KEY: apiKey,
        },
        stdio: ['ignore', 'inherit', 'inherit'],
        shell: false,
      }
    );

    const stdout = '';
    const stderr = '';

    child.on('close', (code) => {
      const summary = `\n[EXIT code=${code}] ${new Date().toISOString()}\n`;
      fs.appendFileSync(AGENT_LOG_FILE, summary);
      console.log(`[cursorAgent] Agent exited with code ${code} for "${item.featureTitle}"`);

      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({
          success: false,
          error: `Agent exited with code ${code}. stderr: ${stderr.slice(0, 500)}`,
        });
      }
    });

    child.on('error', (err) => {
      console.error(`[cursorAgent] Spawn error for "${item.featureTitle}":`, err.message);
      const msg = err.message.includes('ENOENT')
        ? `Cursor CLI not found at resolved path. Tried: ${executable}`
        : err.message;
      resolve({ success: false, error: msg });
    });
  });
}
