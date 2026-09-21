const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const versionsDir = path.join(process.env.LOCALAPPDATA, 'cursor-agent', 'versions');
let exe = null;
let entry = null;
for (const v of fs.readdirSync(versionsDir).sort().reverse()) {
  const n = path.join(versionsDir, v, 'node.exe');
  const e = path.join(versionsDir, v, 'index.js');
  if (fs.existsSync(n) && fs.existsSync(e)) { exe = n; entry = e; break; }
}
console.log('exe:', exe);

const child = spawn(exe, [entry, '-p', '--mode=ask', '--output-format', 'text'], {
  stdio: 'pipe',
  windowsHide: true,
});
let out = '';
let err = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { err += d; });
child.stdin.on('error', (e) => console.log('STDIN ERROR:', e.message));
child.on('error', (e) => console.log('SPAWN ERROR:', e.message));
child.on('close', (code) => {
  console.log('exit code:', code);
  console.log('stdout:', out.trim().slice(0, 300));
  if (err.trim()) console.log('stderr:', err.trim().slice(0, 300));
});
child.stdin.end('Reply with exactly: PIPE_OK');
