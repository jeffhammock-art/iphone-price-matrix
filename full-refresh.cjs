const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = process.argv[2] || '.';
const timings = [];
const t0 = Date.now();

function run(label, cmd) {
  const start = Date.now();
  console.log(`\n=== ${label} ===`);
  console.log(`  cmd: ${cmd}`);
  try {
    const out = execSync(cmd, { cwd: root, maxBuffer: 50 * 1024 * 1024, encoding: 'utf8' });
    console.log(out.slice(0, 4000));
    if (out.length > 4000) console.log(`  [... truncated ${out.length - 4000} more chars]`);
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    const stdout = err.stdout ? err.stdout.toString() : '';
    console.log(stdout.slice(0, 2000));
    console.log(stderr.slice(0, 2000));
    console.log(`  [exit code ${err.status}]`);
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  timings.push({ label, elapsedSec: elapsed });
  console.log(`  ⏱ ${label}: ${elapsed}s`);
}

// 0. Clean up old coverage logs
run('cleanup old logs', `powershell -NoProfile -Command "Remove-Item '${path.join(root, 'data', 'backmarket-*.log')}' -Force -ErrorAction SilentlyContinue; Remove-Item '${path.join(root, 'data', 'amazon-*.log')}' -Force -ErrorAction SilentlyContinue; Remove-Item '${path.join(root, 'data', 'refurbed-*.log')}' -Force -ErrorAction SilentlyContinue; Remove-Item '${path.join(root, 'data', 'musicmagpie-*.log')}' -Force -ErrorAction SilentlyContinue; Write-Output 'old logs cleared'"`);

// 1. Back Market crawl (parallel)
run('crawl Back Market (parallel)', `npm run crawl -- --site Back Market --all --concurrency 6`);

// 2. Amazon crawl
run('crawl Amazon.co.uk', `npm run crawl -- --site Amazon.co.uk --all`);

// 3. Refurbed crawl
run('crawl Refurbed.co.uk', `npm run crawl -- --site Refurbed.co.uk --all`);

// 4. MusicMagpie crawl
run('crawl musicMagpie', `npm run crawl -- --site musicMagpie --all`);

// 5. Clean all
run('clean all sites', `npm run clean -- --all`);

// 6. Build dashboard
run('build dashboard', `npm run dashboard`);

const total = ((Date.now() - t0) / 60).toFixed(1);
console.log(`\n${'='.repeat(60)}`);
console.log(`FULL REFRESH COMPLETE — total wall-clock: ${total} min`);
console.log(`${'='.repeat(60)}`);
timings.forEach(({ label, elapsedSec }) => {
  console.log(`  ${label.padEnd(30)} ${elapsedSec.padStart(6)}s`);
});

// Write timings to file
fs.writeFileSync(path.join(root, 'data', 'refresh-timings.txt'), 
  `Full refresh completed at ${new Date().toISOString()}\nTotal: ${total} min\n\n` +
  timings.map(({ label, elapsedSec }) => `${label}: ${elapsedSec}s`).join('\n') + '\n',
  'utf8');
console.log(`\nTimings written to data/refresh-timings.txt`);
