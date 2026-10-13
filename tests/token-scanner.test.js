// tests/token-scanner.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { extractTokenData } = require('../lib/token-scanner');

describe('token-scanner', () => {
  it('should extract token data from message', () => {
    const message = {
      type: 'assistant',
      uuid: 'test-uuid-123',
      sessionId: 'test-session',
      cwd: '/test/project',
      timestamp: '2026-03-09T10:00:00.000Z',
      message: {
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 20
        }
      }
    };

    const data = extractTokenData(message, '/test/file.jsonl');

    assert.strictEqual(data.message_id, 'test-uuid-123');
    assert.strictEqual(data.session_id, 'test-session');
    assert.strictEqual(data.project_path, '/test/project');
    assert.strictEqual(data.model, 'claude-sonnet-4-6');
    assert.strictEqual(data.input_tokens, 100);
    assert.strictEqual(data.output_tokens, 50);
    assert.strictEqual(data.cache_creation_tokens, 10);
    assert.strictEqual(data.cache_read_tokens, 20);
  });

  it('should return null for non-assistant messages', () => {
    const message = {
      type: 'user',
      uuid: 'test-uuid-123'
    };

    const data = extractTokenData(message, '/test/file.jsonl');
    assert.strictEqual(data, null);
  });

  it('should return null for messages without usage', () => {
    const message = {
      type: 'assistant',
      uuid: 'test-uuid-123',
      message: {}
    };

    const data = extractTokenData(message, '/test/file.jsonl');
    assert.strictEqual(data, null);
  });
});
