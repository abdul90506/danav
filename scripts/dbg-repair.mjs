import { repairJsonText } from '../server/agent/partial.js';

const HTML = '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <div class="wrap">hi</div>\n</body>\n</html>\n';
const cases = {
  'missing comma + escaped body': `{"path": "index.html" "content": ${JSON.stringify(HTML)}}`,
  'missing comma + raw newlines': '{"path": "index.html" "content": "' + HTML + '"}',
  'unescaped inner quotes only': `{"path": "index.html", "content": "${HTML.replace(/\n/g, '\\n')}"}`,
  'bare keys': '{path: "index.html", content: "a\\nb\\nc\\n"}',
  'trailing comma': '{"path": "index.html", "content": "a\\nb\\nc\\n",}',
  'fenced': '```json\n{"path": "index.html", "content": "a\\nb\\n"}\n```',
  'prose around': 'Sure! {"path": "index.html", "content": "a\\nb\\n"} Hope that helps.',
  'escaped braces in body': '{"path": "a.json", "content": "{\\"a\\": 1}\\nplain text\\n"}',
  'body with colon-ish text': '{"path": "notes.md", "content": "note: this is fine\\nand this: also" }',
  'single quotes': "{'path': 'index.html', 'content': 'a\\nb\\nc\\n'}",
  'already valid': '{"path": "index.html", "content": "a\\nb\\n"}',
};

for (const [label, text] of Object.entries(cases)) {
  const r = repairJsonText(text);
  let parsed = null;
  let err = null;
  try { parsed = JSON.parse(r ? r.text : text); } catch (e) { err = e.message; }
  const got = parsed ? `path=${JSON.stringify(parsed.path)} lines=${String(parsed.content ?? '').split('\n').length}` : null;
  console.log(`${err ? 'FAIL' : ' ok '} ${label.padEnd(30)} ${err || got}`);
  if (parsed && String(parsed.content).includes('wrap')) console.log('        content ok:', JSON.stringify(parsed.content.slice(0, 60)));
}
