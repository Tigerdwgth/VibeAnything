// tests/file-browser.test.js
const assert = require('node:assert');
const { test } = require('node:test');
const { listDir } = require('../lib/ws-client');

test('listDir returns dirs only', () => {
  const result = listDir('/tmp');
  assert.ok(Array.isArray(result));
  for (const entry of result) {
    assert.ok('name' in entry);
    assert.ok('path' in entry);
  }
});

test('listDir handles missing path', () => {
  const result = listDir('/nonexistent/path/xyz');
  assert.deepStrictEqual(result, []);
});

test('listDir excludes hidden dirs', () => {
  const result = listDir('/root');
  for (const entry of result) {
    assert.ok(!entry.name.startsWith('.'));
  }
});
