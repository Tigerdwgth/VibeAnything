const { describe, it } = require('node:test');
const assert = require('node:assert');
const { isRoot, getTailscaleIP } = require('../lib/deploy');

describe('Deploy Module', () => {
  it('should check root permission', () => {
    const result = isRoot();
    assert.strictEqual(typeof result, 'boolean');
  });

  it('should detect Tailscale IP or return null', () => {
    const ip = getTailscaleIP();
    if (ip !== null) {
      assert.strictEqual(typeof ip, 'string');
      assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/);
    }
  });
});
