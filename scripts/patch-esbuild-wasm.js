/**
 * Replaces all native esbuild copies with esbuild-wasm in node_modules.
 *
 * Corporate Windows group policy (AppLocker/WDAC) blocks native .exe files
 * inside node_modules. esbuild-wasm is a drop-in WASM replacement that
 * doesn't need a native binary.
 *
 * Runs automatically via the "postinstall" npm script.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const wasmSrc = path.join(root, 'node_modules', 'esbuild-wasm');

if (!fs.existsSync(wasmSrc)) {
  console.log('[patch-esbuild-wasm] esbuild-wasm not found, skipping.');
  process.exit(0);
}

function findEsbuildDirs(dir, depth) {
  if (depth > 6) return [];
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.cache' || entry.name === 'esbuild-wasm') continue;
    const full = path.join(dir, entry.name);
    if (entry.name === 'esbuild' && fs.existsSync(path.join(full, 'lib', 'main.js'))) {
      results.push(full);
    } else {
      results.push(...findEsbuildDirs(full, depth + 1));
    }
  }
  return results;
}

const targets = findEsbuildDirs(path.join(root, 'node_modules'), 0);

if (targets.length === 0) {
  console.log('[patch-esbuild-wasm] No native esbuild copies found.');
  process.exit(0);
}

let patched = 0;
for (const target of targets) {
  const rel = path.relative(root, target);
  const marker = path.join(target, '.esbuild-wasm-patched');
  if (fs.existsSync(marker)) {
    console.log(`[patch-esbuild-wasm] ${rel} already patched.`);
    continue;
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(wasmSrc, target, { recursive: true });
  fs.writeFileSync(marker, new Date().toISOString());
  console.log(`[patch-esbuild-wasm] Replaced ${rel} with esbuild-wasm.`);
  patched++;
}

console.log(`[patch-esbuild-wasm] Done. ${patched} replaced, ${targets.length - patched} already patched.`);
