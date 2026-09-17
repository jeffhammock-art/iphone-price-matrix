const fs = require('fs');
const dataDir = 'data';

console.log('=== Dashboard server check ===');
const dashboardHtml = fs.existsSync(dataDir + '/iphone-dashboard.html');
console.log('Dashboard HTML exists:', dashboardHtml);
if (dashboardHtml) {
  const html = fs.readFileSync(dataDir + '/iphone-dashboard.html', 'utf8');
  const records = (html.match(/"model":"/g) || []).length;
  console.log('Records in dashboard:', records);
}

console.log('\n=== Data summary ===');
const csvs = fs.readdirSync(dataDir).filter(f => f.endsWith('.csv') && !f.includes('-coverage'));
const totalCsvSize = csvs.reduce((a, f) => a + fs.statSync(dataDir + '/' + f).size, 0);
console.log('CSV files:', csvs.length, '| Total size:', Math.round(totalCsvSize / 1024), 'KB');

const jsonls = fs.readdirSync(dataDir).filter(f => f.endsWith('.jsonl'));
const totalJsonlSize = jsonls.reduce((a, f) => a + fs.statSync(dataDir + '/' + f).size, 0);
console.log('JSONL files:', jsonls.length, '| Total size:', Math.round(totalJsonlSize / 1024), 'KB');

console.log('\n=== Per-site CSV counts ===');
const sites = {};
csvs.forEach(f => {
  const match = f.match(/^(backmarket|amazon|refurbed|musicmagpie)-/);
  if (match) {
    sites[match[1]] = (sites[match[1]] || 0) + 1;
  }
});
Object.entries(sites).forEach(([site, count]) => {
  console.log(site + ':', count, 'CSVs');
});

console.log('\n=== Recent file modifications (last 2 hours) ===');
const now = Date.now();
const recent = fs.readdirSync(dataDir).filter(f => !f.startsWith('.') && !f.startsWith('archive') && !f.startsWith('backup') && !f.startsWith('debug') && !f.startsWith('incidents')).sort().filter(f => {
  const s = fs.statSync(dataDir + '/' + f);
  return (now - s.mtimeMs) < 7200000;
});
recent.forEach(f => {
  const s = fs.statSync(dataDir + '/' + f);
  const age = (now - s.mtimeMs) / 1000;
  const ageStr = age < 60 ? age + 's ago' : Math.round(age / 60) + 'm ago';
  console.log(f.padEnd(55), Math.round(s.size / 1024) + 'KB', ageStr);
});