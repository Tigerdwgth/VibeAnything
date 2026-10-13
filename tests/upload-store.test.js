// 开发机侧落盘的单测：真写真读，临时目录里跑，不替身文件系统。
// 重点是两类不能出事的地方：① 浏览器给的文件名是不可信输入（路径穿越 / 隐藏文件）；
// ② 尺寸闸门（不能让一条 ws 消息把 daemon 内存撑爆）。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { saveUpload, sanitizeName, uniquePath } = require('../lib/upload-store');

function tmpBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'va-upload-'));
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('落盘：内容一字节不差，路径在当天目录下', () => {
  const base = tmpBase();
  const now = new Date(2026, 8, 17, 3, 4, 5);
  const { path: saved, bytes } = saveUpload(
    { name: 'shot.png', data: PNG.toString('base64') },
    { baseDir: base, now },
  );

  assert.strictEqual(bytes, PNG.length);
  assert.strictEqual(path.dirname(saved), path.join(base, '2026-09-17'));
  assert.strictEqual(path.basename(saved), '030405-shot.png');
  assert.deepStrictEqual(fs.readFileSync(saved), PNG);
  assert.ok(path.isAbsolute(saved), '回给前端的必须是绝对路径，claude 才读得到');
});

test('落盘权限 0600：上传物可能是截图，别让同机其他用户随便读', () => {
  const base = tmpBase();
  const { path: saved } = saveUpload({ name: 'a.png', data: PNG.toString('base64') }, { baseDir: base });
  assert.strictEqual(fs.statSync(saved).mode & 0o777, 0o600);
});

test('同一秒连传同名文件不互相覆盖', () => {
  const base = tmpBase();
  const now = new Date(2026, 8, 17, 3, 4, 5);
  const a = saveUpload({ name: 'a.png', data: PNG.toString('base64') }, { baseDir: base, now });
  const b = saveUpload({ name: 'a.png', data: PNG.toString('base64') }, { baseDir: base, now });
  assert.notStrictEqual(a.path, b.path);
  assert.strictEqual(path.basename(b.path), '030405-a-1.png');
  assert.ok(fs.existsSync(a.path) && fs.existsSync(b.path));
});

test('路径穿越的文件名写不出上传目录', () => {
  const base = tmpBase();
  const { path: saved } = saveUpload(
    { name: '../../../../tmp/pwned.png', data: PNG.toString('base64') },
    { baseDir: base },
  );
  assert.ok(saved.startsWith(base + path.sep), `逃出上传目录：${saved}`);
  assert.strictEqual(path.basename(saved).endsWith('-pwned.png'), true);
});

test('前导点被剥掉：不写隐藏文件（.bashrc 这类）', () => {
  const base = tmpBase();
  const { path: saved } = saveUpload({ name: '.bashrc', data: PNG.toString('base64') }, { baseDir: base });
  assert.ok(!path.basename(saved).startsWith('.'));
  assert.ok(saved.endsWith('-bashrc'));
});

test('sanitizeName：目录分隔、控制字符、空名都能收口', () => {
  assert.strictEqual(sanitizeName('a/b/c.png'), 'c.png');
  assert.strictEqual(sanitizeName('a\nb.png'), 'ab.png');
  assert.strictEqual(sanitizeName('..'), 'upload.bin');
  assert.strictEqual(sanitizeName(''), 'upload.bin');
  assert.strictEqual(sanitizeName('中文名.png'), '中文名.png');
});

test('sanitizeName：超长名截断但保住扩展名', () => {
  const long = 'x'.repeat(500) + '.png';
  const out = sanitizeName(long);
  assert.ok(Buffer.byteLength(out) <= 200);
  assert.ok(out.endsWith('.png'), '扩展名要留着，claude 靠它认图片');
});

test('超过上限的文件被拒，且不落盘', () => {
  const base = tmpBase();
  const big = Buffer.alloc(3 * 1024 * 1024).toString('base64');
  assert.throws(
    () => saveUpload({ name: 'big.png', data: big }, { baseDir: base, maxUploadMB: 2 }),
    /2MB/,
  );
  // 连日期目录都不该留下半个文件
  const dirs = fs.existsSync(base) ? fs.readdirSync(base) : [];
  const files = dirs.flatMap(d => fs.readdirSync(path.join(base, d)));
  assert.deepStrictEqual(files, []);
});

test('空内容被拒', () => {
  const base = tmpBase();
  assert.throws(() => saveUpload({ name: 'a.png', data: '' }, { baseDir: base }), /为空/);
  assert.throws(() => saveUpload({ name: 'a.png', data: null }, { baseDir: base }), /为空/);
});

test('uniquePath：目录为空时原样返回', () => {
  const base = tmpBase();
  assert.strictEqual(uniquePath(base, 'a.png'), path.join(base, 'a.png'));
});
