// E2E runner: builds are served by `vite preview` on port 4173 (base
// /benchmark_arena/), then every tests/e2e/*.spec.mjs runs sequentially
// against it. Any failing spec fails the runner, so `pnpm run test:e2e`
// can gate pushes and CI deploys.
// Usage: node tests/run-e2e.mjs [spec.mjs ...]   (default: all specs)
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));   // .../tests
const REPO = path.resolve(TESTS_DIR, '..');
const SPECS_DIR = path.join(TESTS_DIR, 'e2e');
const PORT = process.env.E2E_PORT || 4173;
const BASE = `http://127.0.0.1:${PORT}/benchmark_arena/`;

const specs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(SPECS_DIR).filter((f) => f.endsWith('.e2e.mjs')).sort();

if (!specs.length) {
  console.error('no e2e specs found');
  process.exit(1);
}

const viteBin = path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js');
const server = spawn(process.execPath, [viteBin, 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: REPO,
  stdio: ['ignore', 'pipe', 'pipe'],
});

const waitForServer = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

const shutdown = () => { try { server.kill('SIGTERM'); } catch {} };
process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(130); });

const up = await waitForServer();
if (!up) {
  console.error(`preview server did not come up on ${BASE}`);
  console.error(server.stderr.read()?.toString() || '');
  process.exit(1);
}
console.log(`preview server ready: ${BASE}\nrunning ${specs.length} spec(s)\n`);

let failed = 0;
for (const spec of specs) {
  const full = path.isAbsolute(spec) ? spec : path.join(SPECS_DIR, spec);
  console.log(`── ${path.basename(spec)} ${'─'.repeat(Math.max(0, 58 - spec.length))}`);
  const r = spawnSync(process.execPath, [full], {
    cwd: REPO,
    stdio: 'inherit',
    env: { ...process.env, E2E_BASE: BASE },
  });
  if (r.status !== 0) failed++;
  console.log('');
}

shutdown();
console.log(failed ? `E2E FAILED (${failed} spec(s))` : 'ALL E2E SPECS PASSED');
process.exit(failed ? 1 : 0);
