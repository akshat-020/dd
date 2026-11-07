// Combines src/*.gs into dist/CallDesk.gs so setup is one copy-paste.
// Run: node call-desk/scripts/bundle.js
const fs = require('node:fs');
const path = require('node:path');
const src = path.join(__dirname, '..', 'src');
const files = fs.readdirSync(src).filter((f) => f.endsWith('.gs')).sort();
const parts = files.map((f) => `// ===== ${f} =====\n` + fs.readFileSync(path.join(src, f), 'utf8').trimEnd() + '\n');
const header = '// Call Desk — generated from call-desk/src by scripts/bundle.js. Do not edit here; edit src/ and re-run.\n\n';
fs.writeFileSync(path.join(__dirname, '..', 'dist', 'CallDesk.gs'), header + parts.join('\n'));
console.log('dist/CallDesk.gs from', files.join(', '));
