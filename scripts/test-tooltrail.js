import assert from 'assert';
import { normalizeToolExecutionsForDisk } from '../server/toolTrail.js';

/**
 * Regression tests for how the web-tool trail is written to disk.
 *
 * Two failure modes matter:
 *  - a tool left `running` (the tab closed mid-search) must not come back
 *    pulsing "working…" forever on reload;
 *  - a huge `detail` blob must not be persisted verbatim, or the conversation
 *    store bloats without bound.
 */

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  \u2717 ${name}\n      ${err.message}`);
  }
}

console.log('Tool trail persistence\n');

test('an empty or missing trail is dropped entirely', () => {
  assert.strictEqual(normalizeToolExecutionsForDisk(undefined), undefined);
  assert.strictEqual(normalizeToolExecutionsForDisk(null), undefined);
  assert.strictEqual(normalizeToolExecutionsForDisk([]), undefined);
  assert.strictEqual(normalizeToolExecutionsForDisk('nope'), undefined);
});

test('a running tool is settled to a finished failure', () => {
  const out = normalizeToolExecutionsForDisk([
    { id: 't1', name: 'web_search', status: 'running', query: 'node lts' },
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].status, 'done', 'a running tool must not stay live on disk');
  assert.strictEqual(out[0].ok, false, 'it never finished, so it is not a success');
  assert.strictEqual(out[0].query, 'node lts', 'what was searched is still worth keeping');
});

test('a finished tool keeps its outcome', () => {
  const out = normalizeToolExecutionsForDisk([
    { id: 't1', name: 'web_search', status: 'done', ok: true, summary: '8 results' },
    { id: 't2', name: 'fetch_url', status: 'done', ok: false, summary: 'Failed' },
  ]);
  assert.strictEqual(out[0].ok, true);
  assert.strictEqual(out[0].summary, '8 results');
  assert.strictEqual(out[1].ok, false, 'an honest failure must survive the round trip');
});

test('images are preserved so the gallery can be redrawn', () => {
  const out = normalizeToolExecutionsForDisk([
    { id: 't1', name: 'image_search', status: 'done', images: [{ url: 'a' }, { url: 'b' }] },
  ]);
  assert.strictEqual(out[0].images.length, 2);
});

test('detail is truncated rather than stored verbatim', () => {
  const out = normalizeToolExecutionsForDisk([
    { id: 't1', name: 'fetch_url', status: 'done', detail: 'x'.repeat(50000) },
  ]);
  assert.strictEqual(out[0].detail.length, 600, 'page text must not bloat the store');
});

test('the trail is capped so one turn cannot grow without bound', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    id: `t${i}`,
    name: 'web_search',
    status: 'done',
    query: `q${i}`,
  }));
  const out = normalizeToolExecutionsForDisk(many);
  assert.strictEqual(out.length, 20, 'only the most recent entries are kept');
  assert.strictEqual(out[19].query, 'q59', 'the newest entry must be the one kept');
});

test('entries that are not real tools are discarded', () => {
  const out = normalizeToolExecutionsForDisk([
    { id: 't1', name: 'write_file', status: 'done' },
    { id: 't2', name: 'web_search', status: 'done', ok: true },
    null,
    'garbage',
  ]);
  assert.strictEqual(out.length, 1, 'a filesystem tool has no place in the web trail');
  assert.strictEqual(out[0].name, 'web_search');
});

test('an entry with no id still gets one', () => {
  const out = normalizeToolExecutionsForDisk([{ name: 'web_search', status: 'done' }]);
  assert.ok(out[0].id && out[0].id.length > 0, 'React needs a stable key');
});

console.log('\n====================================================');
if (failures.length === 0) {
  console.log(`\uD83C\uDF89 ALL ${passed} TOOL TRAIL TESTS PASSED`);
} else {
  console.log(`${passed} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
}
console.log('====================================================\n');

if (failures.length > 0) process.exit(1);
