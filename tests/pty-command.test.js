// tests/pty-command.test.js
const assert = require('node:assert');
const { test } = require('node:test');
const { PtyManager } = require('../lib/pty-manager');

test('create with custom command', () => {
  const mgr = new PtyManager();
  assert.doesNotThrow(() => mgr.create('s1', {
    command: ['echo', 'hi'], cwd: '/tmp',
    cols: 80, rows: 24, onData: () => {}, onExit: () => {}
  }));
  mgr.destroyAll();
});

test('create defaults to claude', () => {
  const mgr = new PtyManager();
  const p = mgr.create('s2', { cols: 80, rows: 24, onData: () => {}, onExit: () => {} });
  assert.ok(p);
  mgr.destroyAll();
});
