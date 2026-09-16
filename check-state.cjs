const fs = require('fs');

// Read dashboard HTML and extract source counts
const html = fs.readFileSync('data/iphone-dashboard.html', 'utf8');
const sources = html.match(/\"source\":\"([^\"]+)\"/g) || [];
const counts = {};
sources.forEach(s => {
  const m = s.match(/\"source\":\"([^\"]+)\"/);
  if (m) {
    const src = m[1];
    counts[src] = (counts[src] || 0) + 1;
  }
});

console.log('=== Dashboard records by source ===');
Object.entries(counts).sort((a,b) => b[1]-a[1]).forEach(([src, count]) => console.log('  ' + src.padEnd(20) + ': ' + count));
console.log('\nTotal records: ' + sources.length);

const lu = html.match(/lastUpdated\":\"([^\"]+)\"/);
console.log('\nLast updated: ' + (lu ? lu[1] : 'N/A'));

// Read refresh log
console.log('\n=== Refresh log ===');
try {
  const log = fs.readFileSync('data/refresh-log.txt', 'utf8');
  console.log(log.slice(0, 500));
} catch(e) {
  console.log('No refresh log found');
}

// Check Amazon data freshness
console.log('\n=== Amazon data freshness ===');
const amazonFiles = fs.readdirSync('data').filter(f => f.startsWith('amazon-') && f.endsWith('.jsonl')).sort();
amazonFiles.forEach(f => {
  const stat = fs.statSync('data/' + f);
  const ageMins = Math.round((Date.now() - stat.mtimeMs) / 60000);
  console.log('  ' + f.padEnd(40) + ': ' + (stat.size/1024).toFixed(1) + 'KB, ' + ageMins + 'min old');
});
