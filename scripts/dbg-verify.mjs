import { verificationLabel } from '../server/agent/loop.js';
const cmds = [
  'node --test', 'node --test src/greet.test.js', 'cd /tmp/app && node --test',
  'npm test', 'npm run test:suites', 'node --test src/greet.test.js 2>&1 | tail -5',
  'node -e "const fs=require(\'fs\');console.log(fs.readFileSync(\'index.html\',\'utf8\').length)"',
  'curl -s http://localhost:3000 | grep -o "<title>.*</title>"',
  'python3 -m pytest -q', 'npx eslint .', 'node hello.js', 'npm run build',
  'CI=1 npm test', 'node --test greet.test.js && echo OK',
];
for (const c of cmds) console.log(String(verificationLabel(c)).padEnd(12), '←', c.slice(0, 70));
process.exit(0);
