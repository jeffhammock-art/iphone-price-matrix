const fs = require('fs');
const js = fs.readFileSync('src/dashboard.app.js', 'utf8');
console.log('=== dashboard.app.js checks ===');
console.log('Has capturedAt column def:', js.includes("'capturedAt'"));
console.log('Has Retrieved label:', js.includes('label: \'Retrieved\''));
console.log('Has capturedAt cell:', js.includes('row.capturedAt'));
console.log('Has exported capturedAt:', js.includes('row.capturedAt'));

const html = fs.readFileSync('data/iphone-dashboard.html', 'utf8');
const m = html.match(/"capturedAt":"([^"]+)"/g);
console.log('=== iphone-dashboard.html checks ===');
console.log('capturedAt fields:', m ? m.length : 0);
if (m && m.length > 0) console.log('Sample:', m[0]);

