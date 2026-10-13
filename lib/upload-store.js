// 开发机侧：接住浏览器送来的文件，落盘，返回绝对路径。
//
// 链路里的第二棒（第一棒是前端 terminal-upload.js，第三棒是把路径敲进终端）。
// 目的只有一个：让跑在**这台机器**上的 claude / codex 能用一个本地路径读到
// 用户在**浏览器那台机器**上粘贴或拖进来的图片和文件。
//
// 落在 ~/.vibeanything/uploads/<日期>/ 而不是会话的工作目录：工作目录基本都是 git 仓库，
// 往里丢截图会污染 git status，也容易被误提交。集中一处还便于用户整体清理。

const fs = require('node:fs');
const path = require('node:path');
const { getBaseDir } = require('./config');

const DEFAULT_MAX_UPLOAD_MB = 20;

/**
 * 文件名清洗：来自浏览器的名字是**不可信输入**，必须当成攻击面处理。
 * 只取 basename 剥掉任何路径成分，再干掉控制字符与前导点，
 * 防止 `../../.ssh/authorized_keys` 或 `.bashrc` 这类写穿/覆盖。
 */
function sanitizeName(raw) {
  const base = path.basename(String(raw || '').trim());
  const cleaned = base
    .replace(/[\x00-\x1f\x7f]/g, '')      // 控制字符（含换行、制表）
    .replace(/[/\\]/g, '-')                  // basename 之后理论上没有，双保险
    .replace(/^\.+/, '')                     // 前导点：不写隐藏文件，也堵死 '.' 与 '..'
    .trim();
  if (!cleaned) return 'upload.bin';
  // 文件名长度上限（多数文件系统 255 字节），截断时保住扩展名
  if (Buffer.byteLength(cleaned) <= 200) return cleaned;
  const ext = path.extname(cleaned).slice(0, 20);
  return cleaned.slice(0, 200 - ext.length) + ext;
}

/** 当天的上传目录，不存在就建。 */
function uploadDir(baseDir, now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const dir = path.join(baseDir, day);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 同一秒内连贴两张同名图也不能互相覆盖，撞名就加序号。 */
function uniquePath(dir, fileName) {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  let candidate = path.join(dir, fileName);
  for (let i = 1; fs.existsSync(candidate); i += 1) {
    candidate = path.join(dir, `${stem}-${i}${ext}`);
  }
  return candidate;
}

/**
 * 写入一个上传文件。
 *
 * @param {object} upload
 * @param {string} upload.name   浏览器给的原始文件名（不可信）
 * @param {string} upload.data   base64 内容
 * @param {object} [opts]
 * @param {string} [opts.baseDir]    默认 <VIBEANYTHING_HOME|~/.vibeanything>/uploads
 * @param {number} [opts.maxUploadMB] 单文件上限，默认 20MB
 * @param {Date}   [opts.now]
 * @returns {{ path: string, bytes: number }}
 * @throws {Error} 空内容 / 超限 / base64 非法 / 写盘失败
 */
function saveUpload({ name, data }, opts = {}) {
  const maxMB = opts.maxUploadMB || DEFAULT_MAX_UPLOAD_MB;
  if (typeof data !== 'string' || !data) throw new Error('上传内容为空');

  // 先按 base64 长度估算大小再解码：解码一个几百 MB 的串本身就会把 daemon 撑爆
  const approxBytes = Math.floor(data.length * 3 / 4);
  if (approxBytes > maxMB * 1024 * 1024) {
    throw new Error(`文件超过 ${maxMB}MB 上限`);
  }
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) throw new Error('上传内容为空');
  if (buf.length > maxMB * 1024 * 1024) throw new Error(`文件超过 ${maxMB}MB 上限`);

  // 跟着 VIBEANYTHING_HOME 走，与 config/daemon.log 等同处一个根目录
  const baseDir = opts.baseDir || path.join(getBaseDir(), 'uploads');
  const now = opts.now || new Date();
  const dir = uploadDir(baseDir, now);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const target = uniquePath(dir, `${stamp}-${sanitizeName(name)}`);

  fs.writeFileSync(target, buf, { mode: 0o600 });
  return { path: target, bytes: buf.length };
}

module.exports = { saveUpload, sanitizeName, uploadDir, uniquePath, DEFAULT_MAX_UPLOAD_MB };
