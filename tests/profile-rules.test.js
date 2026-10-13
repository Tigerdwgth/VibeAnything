// tests/profile-rules.test.js
// 个人信息（昵称 / 头像）校验规则。
//
// 头像那半边的重点不是「格式对不对」，是**内容完不完整**：2026-09-21 那次事故里，
// 截断的 JPEG 文件头完好、`file(1)` 报得出正确尺寸、解码器也不报错，只是把缺的部分
// 填成灰色。所以这里每种格式都要有一条「头对、尾断」的用例 —— 那才是真会发生的坏数据。

const { test } = require('node:test');
const assert = require('node:assert');

const {
  NICKNAME_MAX_LENGTH, AVATAR_MAX_BYTES,
  validateNickname, validateAvatar,
} = require('../packages/server/profile-rules');

const uri = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;

// 真·1×1 透明 PNG（不是拼出来的字节，解码器能真解开）
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const JPEG = Buffer.concat([
  Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex'),
  Buffer.alloc(64, 0x7f),
  Buffer.from('ffd9', 'hex'),
]);
/** 造一个 RIFF 长度字段自洽的最小 WebP。 */
function makeWebp(payloadSize = 32) {
  const payload = Buffer.alloc(payloadSize, 0x20);
  const buf = Buffer.concat([
    Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), payload,
  ]);
  buf.writeUInt32LE(buf.length - 8, 4);
  return buf;
}

// ── 昵称 ──────────────────────────────────────────────────────

test('昵称：两端空白被裁掉', () => {
  assert.deepStrictEqual(validateNickname('  阿杰 '), { ok: true, value: '阿杰' });
});

test('昵称：不传 / 空串 / 纯空白 都表示清空，不是错误', () => {
  for (const input of [undefined, null, '', '   ']) {
    assert.deepStrictEqual(validateNickname(input), { ok: true, value: null },
      `输入 ${JSON.stringify(input)} 应当被当成「清空昵称」`);
  }
});

test(`昵称：上限 ${NICKNAME_MAX_LENGTH} 个字符，按码点算而不是 UTF-16 长度`, () => {
  assert.strictEqual(validateNickname('x'.repeat(NICKNAME_MAX_LENGTH)).ok, true);
  assert.strictEqual(validateNickname('x'.repeat(NICKNAME_MAX_LENGTH + 1)).ok, false);
  // 每个 emoji 在 .length 里算 2 —— 按 .length 卡会让人只能打一半的字
  const emoji = '🐰'.repeat(NICKNAME_MAX_LENGTH);
  assert.strictEqual(emoji.length, NICKNAME_MAX_LENGTH * 2);
  assert.strictEqual(validateNickname(emoji).ok, true);
  assert.strictEqual(validateNickname('🐰'.repeat(NICKNAME_MAX_LENGTH + 1)).ok, false);
});

test('昵称：换行与控制字符一律拒绝（会把侧边栏那一行撑破）', () => {
  for (const bad of ['a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u001Fb', 'a\u007Fb']) {
    assert.strictEqual(validateNickname(bad).ok, false, `${JSON.stringify(bad)} 应被拒绝`);
  }
});

test('昵称：非字符串拒绝', () => {
  for (const bad of [123, {}, [], true]) {
    assert.strictEqual(validateNickname(bad).ok, false);
  }
});

// ── 头像：正常路径 ────────────────────────────────────────────

test('头像：三种受支持的格式都能通过，并原样回吐规范化后的 data URI', () => {
  for (const [mime, buf] of [['image/png', PNG], ['image/jpeg', JPEG], ['image/webp', makeWebp()]]) {
    const r = validateAvatar(uri(mime, buf));
    assert.strictEqual(r.ok, true, `${mime} 应通过：${r.error}`);
    assert.strictEqual(r.value, uri(mime, buf));
  }
});

test('头像：不传 / null / 空串 表示恢复默认头像', () => {
  for (const input of [undefined, null, '']) {
    assert.deepStrictEqual(validateAvatar(input), { ok: true, value: null });
  }
});

test('头像：MIME 大小写不敏感，落库统一成小写', () => {
  const r = validateAvatar(`data:IMAGE/PNG;base64,${PNG.toString('base64')}`);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.startsWith('data:image/png;base64,'), true);
});

// ── 头像：截断检测（这组才是重点）────────────────────────────

test('头像：base64 长度不是 4 的倍数 = 一定丢了字符', () => {
  const b64 = PNG.toString('base64');
  const r = validateAvatar(`data:image/png;base64,${b64.slice(0, b64.length - 1)}`);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /截断/);
});

test('头像：PNG 头完好但缺 IEND —— 只看文件头的校验会放它过去', () => {
  const truncated = PNG.subarray(0, PNG.length - 12);
  // 文件头仍然是合法 PNG，肉眼/file(1) 看不出问题
  assert.strictEqual(truncated.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const r = validateAvatar(uri('image/png', truncated));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /IEND/);
});

test('头像：JPEG 头完好但缺 EOI —— 正是那次上线后变灰方块的形态', () => {
  const truncated = JPEG.subarray(0, JPEG.length - 2);
  assert.strictEqual(truncated.subarray(0, 3).toString('hex'), 'ffd8ff');
  const r = validateAvatar(uri('image/jpeg', truncated));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /EOI/);
});

test('头像：WebP 的 RIFF 长度字段与实际字节数对不上', () => {
  const buf = makeWebp();
  buf.writeUInt32LE(buf.length + 100, 4); // 谎报长度
  const r = validateAvatar(uri('image/webp', buf));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /RIFF/);
});

test('头像：声明 PNG 却塞了 JPEG 的字节', () => {
  const r = validateAvatar(uri('image/png', JPEG));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /PNG 文件头/);
});

// ── 头像：格式与体积 ──────────────────────────────────────────

test('头像：非 data URI 拒绝（含 http 外链 —— 不能让库里存一个会变的地址）', () => {
  for (const bad of ['https://example.com/a.png', 'data:image/png,notbase64', 'hello', 42, {}]) {
    assert.strictEqual(validateAvatar(bad).ok, false, `${JSON.stringify(bad)} 应被拒绝`);
  }
});

test('头像：GIF / SVG 不在白名单（SVG 能带脚本，头像位上尤其不能收）', () => {
  assert.strictEqual(validateAvatar(uri('image/gif', PNG)).ok, false);
  assert.strictEqual(validateAvatar(uri('image/svg+xml', PNG)).ok, false);
});

test('头像：base64 里混进非法字符', () => {
  const b64 = PNG.toString('base64');
  const r = validateAvatar(`data:image/png;base64,${b64.slice(0, 4)}!!!!${b64.slice(8)}`);
  assert.strictEqual(r.ok, false);
});

test(`头像：超过 ${AVATAR_MAX_BYTES / 1024}KB 拒绝，且在解码之前就拒绝`, () => {
  // 长度检查走 base64 段长度，不需要真的把超大图解出来
  const oversized = 'A'.repeat(Math.ceil((AVATAR_MAX_BYTES + 1024) / 3) * 4);
  const r = validateAvatar(`data:image/png;base64,${oversized}`);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /KB/);
});

test('头像：data URI 里的换行被容忍（有些客户端会折行）', () => {
  const b64 = PNG.toString('base64');
  const folded = b64.slice(0, 20) + '\n' + b64.slice(20);
  const r = validateAvatar(`data:image/png;base64,${folded}`);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value, uri('image/png', PNG));
});
