// packages/server/profile-rules.js
// 个人信息（昵称 / 头像）的校验规则 —— 服务端权威实现，HTTP 路由与 auth 层共用一份。
//
// 头像为什么以 data URI 存进 users 表而不是落盘成文件：
// 部署流程（见 CLAUDE.md）只把 users.db 当持久数据，frontend/dist 是 `rsync --delete`
// 的目标、其余目录靠逐个列举同步。另开一个头像目录等于多一条运维路径 —— 放 dist 下会被
// --delete 清掉，放别处又容易在下次部署时漏同步。把图压到 256×256 塞进库里，头像就跟着
// 已有的备份/同步路径走，不需要第二套。
//
// 代价是 sql.js 每次 saveDb 都全量导出，所以尺寸上限卡得很死（见 AVATAR_MAX_BYTES）。

const NICKNAME_MAX_LENGTH = 24;
const AVATAR_MAX_BYTES = 256 * 1024;
const AVATAR_MIMES = ['image/png', 'image/jpeg', 'image/webp'];

const DATA_URI_RE = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([\s\S]*)$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

/**
 * 校验昵称。空串 / 空白串 = 清空昵称（回落显示用户名），不是错误。
 * @param {unknown} raw
 * @returns {{ok: true, value: string|null} | {ok: false, error: string}}
 */
function validateNickname(raw) {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: '昵称必须是字符串' };
  if (CONTROL_CHAR_RE.test(raw)) return { ok: false, error: '昵称不能包含换行或控制字符' };
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  // 按码点数而不是 .length：一个 emoji 在 UTF-16 里占 2，按 .length 算会平白少让人打几个字。
  if (Array.from(value).length > NICKNAME_MAX_LENGTH) {
    return { ok: false, error: `昵称最多 ${NICKNAME_MAX_LENGTH} 个字符` };
  }
  return { ok: true, value };
}

/** base64 段解码后应有的字节数。长度非 4 的倍数时返回 null（调用方据此判定截断）。 */
function decodedByteLength(b64) {
  if (b64.length % 4 !== 0) return null;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length / 4) * 3 - padding;
}

function startsWithBytes(buf, bytes, offset = 0) {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

function endsWithBytes(buf, bytes) {
  if (buf.length < bytes.length) return false;
  return bytes.every((b, i) => buf[buf.length - bytes.length + i] === b);
}

/**
 * 按声明的 MIME 校验解码后的字节：不光看文件头，还要看结束标记。
 *
 * 这是 2026-09-21 那次事故的直接产物 —— 截断的 JPEG 文件头完好，`file(1)` 照样报得出
 * 正确尺寸，解码器也不报错，只是把缺的部分填成灰色。只验元数据等于没验，必须看尾巴。
 */
function checkImageBytes(mime, buf) {
  if (mime === 'image/png') {
    if (!startsWithBytes(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
      return 'PNG 文件头不合法';
    }
    // IEND chunk：长度(0) + 'IEND' + CRC。缺了就是没写完。
    if (!endsWithBytes(buf, [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])) {
      return 'PNG 数据不完整（缺少 IEND 结束块）';
    }
    return null;
  }
  if (mime === 'image/jpeg') {
    if (!startsWithBytes(buf, [0xff, 0xd8, 0xff])) return 'JPEG 文件头不合法';
    if (!endsWithBytes(buf, [0xff, 0xd9])) return 'JPEG 数据不完整（缺少 EOI 结束标记）';
    return null;
  }
  if (mime === 'image/webp') {
    if (!startsWithBytes(buf, [0x52, 0x49, 0x46, 0x46]) ||
        !startsWithBytes(buf, [0x57, 0x45, 0x42, 0x50], 8)) {
      return 'WebP 文件头不合法';
    }
    // RIFF 头里写着自己的长度，对不上就是被截断/被改过。
    if (buf.readUInt32LE(4) !== buf.length - 8) return 'WebP 数据不完整（RIFF 长度与实际不符）';
    return null;
  }
  return `不支持的图片格式：${mime}`;
}

/**
 * 校验头像 data URI。空值 = 恢复默认头像，不是错误。
 * @param {unknown} raw
 * @returns {{ok: true, value: string|null} | {ok: false, error: string}}
 */
function validateAvatar(raw) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: '头像必须是 data URI 字符串' };

  const m = DATA_URI_RE.exec(raw.trim());
  if (!m) return { ok: false, error: '头像必须是 data:<mime>;base64,<数据> 格式' };

  const mime = m[1].toLowerCase();
  if (!AVATAR_MIMES.includes(mime)) {
    return { ok: false, error: `头像格式只支持 ${AVATAR_MIMES.join(' / ')}` };
  }

  const b64 = m[2].replace(/\s+/g, '');
  if (!b64) return { ok: false, error: '头像数据为空' };
  if (!BASE64_RE.test(b64)) return { ok: false, error: '头像数据不是合法的 base64' };
  // 长度不是 4 的倍数 = 一定丢了字符。零成本自检，放在解码之前。
  const expected = decodedByteLength(b64);
  if (expected === null) return { ok: false, error: '头像数据被截断（base64 长度不是 4 的倍数）' };
  if (expected > AVATAR_MAX_BYTES) {
    return { ok: false, error: `头像不能超过 ${Math.floor(AVATAR_MAX_BYTES / 1024)}KB` };
  }

  const buf = Buffer.from(b64, 'base64');
  // Buffer.from 对非法 base64 是静默丢弃而不是抛错，长度对不上说明中间混了脏字符。
  if (buf.length !== expected) return { ok: false, error: '头像数据被截断或含非法字符' };

  const bytesError = checkImageBytes(mime, buf);
  if (bytesError) return { ok: false, error: bytesError };

  return { ok: true, value: `data:${mime};base64,${b64}` };
}

module.exports = {
  NICKNAME_MAX_LENGTH, AVATAR_MAX_BYTES, AVATAR_MIMES,
  validateNickname, validateAvatar,
};
