const fs = require('fs');
const path = require('path');

const dataDir = 'data';

console.log('=== CSV files ===');
const csvs = [];
try {
  fs.readdirSync(dataDir).filter(f => f.endsWith('.csv')).sort().forEach(f => {
    const p = path.join(dataDir, f);
    const s = fs.statSync(p);
    csvs.push({ name: f, size: s.size, mtime: s.mtime });
    console.log(`  ${f.padEnd(45)} ${(s.size/1024).toFixed(1).padStart(7)} KB  ${s.mtime.toISOString().slice(0,19).replace('T',' ')}`);
  });
} catch(e) { console.error('CSV list error:', e.message); }

console.log('\n=== JSONL files ===');
const jsonls = [];
try {
  fs.readdirSync(dataDir).filter(f => f.endsWith('.jsonl')).sort().forEach(f => {
    const p = path.join(dataDir, f);
    const s = fs.statSync(p);
    jsonls.push({ name: f, size: s.size, mtime: s.mtime });
    console.log(`  ${f.padEnd(45)} ${(s.size/1024).toFixed(1).padStart(7)} KB  ${s.mtime.toISOString().slice(0,19).replace('T',' ')}`);
  });
} catch(e) { console.error('JSONL list error:', e.message); }

console.log('\n=== Coverage logs ===');
const logs = [];
try {
  fs.readdirSync(dataDir).filter(f => f.endsWith('.log')).sort().forEach(f => {
    const p = path.join(dataDir, f);
    const s = fs.statSync(p);
    logs.push({ name: f, size: s.size, mtime: s.mtime });
    console.log(`  ${f.padEnd(50)} ${(s.size/1024).toFixed(1).padStart(7)} KB  ${s.mtime.toISOString().slice(0,19).replace('T',' ')}`);
  });
} catch(e) { console.error('Log list error:', e.message); }

console.log('\n=== Summary ===');
const totalCsv = csvs.reduce((a,f) => a + f.size, 0);
const totalJsonl = jsonls.reduce((a,f) => a + f.size, 0);
const totalLogs = logs.reduce((a,f) => a + f.size, 0);
console.log(`  CSV: ${csvs.length} files, ${(totalCsv/1024).toFixed(1)} KB total`);
console.log(`  JSONL: ${jsonls.length} files, ${(totalJsonl/1024).toFixed(1)} KB total`);
console.log(`  Logs: ${logs.length} files, ${(totalLogs/1024).toFixed(1)} KB total`);
try {
  const profiles = fs.readdirSync(path.join(dataDir,'.chrome-profile'));
  console.log(`  Chrome profiles: ${profiles.length} dirs`);
} catch(e) { console.log('  Chrome profiles: N/A'); }
