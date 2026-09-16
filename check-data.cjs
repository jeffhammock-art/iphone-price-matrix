const fs = require('fs');
const path = require('path');
const dataDir = 'data';

console.log('=== Data files ===');
try {
  const entries = fs.readdirSync(dataDir);
  entries.forEach(f => {
    const p = path.join(dataDir, f);
    const s = fs.statSync(p);
    const sizeKB = (s.size / 1024).toFixed(0);
    const mtime = new Date(s.mtime).toISOString().slice(0, 19).replace('T', ' ');
    if (s.isDirectory()) {
      const kids = fs.readdirSync(p);
      console.log(`DIR  ${f}/ (${kids.length} files, ${sizeKB}KB total)`);
    } else {
      console.log(`FILE ${f}  ${sizeKB}KB  ${mtime}`);
    }
  });
} catch (e) {
  console.log('Error:', e.message);
}


