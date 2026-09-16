const fs = require('fs');

// 1. Dashboard file: records per site + distinct models
const html = fs.readFileSync('data/iphone-dashboard.html', 'utf8');
const sites = {};
for (const m of html.matchAll(/"site":"([^"]+)"/g)) sites[m[1]] = (sites[m[1]] || 0) + 1;
const models = new Set();
for (const m of html.matchAll(/"model":"([^"]+)"/g)) models.add(m[1]);
const stat = fs.statSync('data/iphone-dashboard.html');
console.log('=== Dashboard ===');
console.log('data/iphone-dashboard.html:', Math.round(stat.size / 1024) + ' KB, built', stat.mtime.toISOString());
console.log('records per site:', sites);
console.log('distinct models:', models.size);

// 2. Clean CSV row counts per site
console.log('\n=== Clean CSV rows ===');
for (const prefix of ['amazon', 'backmarket', 'refurbed', 'musicmagpie']) {
  const files = fs.readdirSync('data').filter(f => f.startsWith(prefix) && f.endsWith('-clean.csv')).sort();
  let total = 0;
  const parts = [];
  for (const f of files) {
    const n = fs.readFileSync('data/' + f, 'utf8').split('\n').filter(l => l.trim()).length - 1;
    total += n;
    parts.push(f.replace(prefix + '-', '').replace('-clean.csv', '') + ':' + n);
  }
  console.log(prefix.padEnd(12) + ' total=' + String(total).padStart(4) + '  ' + parts.join(' '));
}
