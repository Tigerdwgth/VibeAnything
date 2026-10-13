// tests/token-storage.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { initDatabase, insertTokenUsage, batchInsertTokenUsage, queryTokenStats, closePool, getPool } = require('../lib/token-storage');

describe('token-storage', () => {
  before(async () => {
    await initDatabase();
  });

  after(async () => {
    // 清理测试数据
    const pool = await getPool();
    await pool.query('DELETE FROM token_usage WHERE message_id LIKE \'test-%\'');
    await closePool();
  });

  it('should insert token usage', async () => {
    const data = {
      machine_id: 'test-machine',
      session_id: 'test-session',
      project_path: '/test/project',
      message_id: 'test-msg-1',
      model: 'claude-sonnet-4-6',
      timestamp: Date.now(),
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_tokens: 10,
      cache_read_tokens: 20
    };

    const success = await insertTokenUsage(data);
    assert.strictEqual(success, true);
  });

  it('should handle duplicate message_id', async () => {
    const data = {
      machine_id: 'test-machine',
      session_id: 'test-session',
      project_path: '/test/project',
      message_id: 'test-msg-2',
      model: 'claude-sonnet-4-6',
      timestamp: Date.now(),
      input_tokens: 100,
      output_tokens: 50
    };

    const success1 = await insertTokenUsage(data);
    assert.strictEqual(success1, true);

    const success2 = await insertTokenUsage(data);
    assert.strictEqual(success2, false); // 重复插入应该被忽略
  });

  it('should batch insert token usage', async () => {
    const dataArray = [
      {
        machine_id: 'test-machine',
        session_id: 'test-session',
        project_path: '/test/project',
        message_id: 'test-msg-3',
        model: 'claude-sonnet-4-6',
        timestamp: Date.now(),
        input_tokens: 100,
        output_tokens: 50
      },
      {
        machine_id: 'test-machine',
        session_id: 'test-session',
        project_path: '/test/project',
        message_id: 'test-msg-4',
        model: 'claude-sonnet-4-6',
        timestamp: Date.now(),
        input_tokens: 200,
        output_tokens: 100
      }
    ];

    const inserted = await batchInsertTokenUsage(dataArray);
    assert.strictEqual(inserted, 2);
  });

  it('should query token stats', async () => {
    const stats = await queryTokenStats({
      machineId: 'test-machine'
    });

    assert.ok(stats.total_tokens > 0);
    assert.ok(stats.message_count >= 4);
  });
});
