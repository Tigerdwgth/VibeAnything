// tests/session-history.test.js
const assert = require('node:assert');
const { test } = require('node:test');
const { scanSessionHistory } = require('../lib/ws-client');

test('scanSessionHistory returns array', async () => {
  const result = await scanSessionHistory();
  assert.ok(Array.isArray(result));
});

test('session has required fields', async () => {
  const result = await scanSessionHistory();
  if (result.length > 0) {
    assert.ok('sessionId' in result[0]);
    assert.ok('cwd' in result[0]);
    assert.ok('timestamp' in result[0]);
    assert.ok('summary' in result[0]);
  }
});

test('sessions sorted by timestamp descending', async () => {
  const result = await scanSessionHistory();
  for (let i = 1; i < result.length; i++) {
    assert.ok(result[i - 1].timestamp >= result[i].timestamp);
  }
});
