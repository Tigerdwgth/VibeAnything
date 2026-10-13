// 个人信息（头像 / 昵称）的前端纯逻辑：显示时的回落规则，以及把用户选的图片
// 压成可以直接入库的 data URI。组件只管画，规则都在这儿，好单独测。
//
// 校验规则的权威实现在 packages/server/profile-rules.js —— 这边这份只是为了让用户
// 在点「保存」之前就看到提示，两边万一漂移，以服务端返回的错误为准（弹窗会原样显示）。

/**
 * 站点默认头像：侧边栏左上角那只兔子。
 * 没设过头像的用户显示它 —— 库里存的是 null 而不是这个路径，将来换默认图时
 * 存量用户才会跟着一起换（见 auth.js 的 migrateProfileColumns）。
 */
export const DEFAULT_AVATAR = '/usagi.png';

export const NICKNAME_MAX_LENGTH = 24;

// 落库的头像尺寸。256 见方在 2 倍屏上够清楚，JPEG 压完通常 15–25KB ——
// 头像是跟着 users.db 走的，而 sql.js 每次保存都全量导出，尺寸必须压住。
export const AVATAR_SIZE = 256;
export const AVATAR_MIME = 'image/jpeg';
export const AVATAR_QUALITY = 0.85;

// 选图阶段的闸门：真正的上限在服务端（256KB 压缩后），这里拦的是「别把浏览器
// 卡死在解码一张 80MB 的原图上」。
export const MAX_SOURCE_BYTES = 12 * 1024 * 1024;

// 浏览器能解、且重编码后不会出事的输入格式。SVG 不收：它能带脚本，
// 而且尺寸靠 CSS 决定，画到 canvas 上行为不一致。
export const ACCEPTED_SOURCE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'];

/** 界面上该显示的名字：设过昵称用昵称，没设过退回用户名。 */
export function displayNameOf(profile) {
  const nickname = typeof profile?.nickname === 'string' ? profile.nickname.trim() : '';
  return nickname || profile?.username || '';
}

/** 该显示哪张头像：设过用自己的，没设过用站点默认图。 */
export function avatarSrcOf(profile) {
  return profile?.avatar || DEFAULT_AVATAR;
}

/** 这个用户是不是还在用默认头像（决定「恢复默认」按钮要不要点得动）。 */
export function usesDefaultAvatar(profile) {
  return !profile?.avatar;
}

/**
 * 昵称预检。返回错误文案，没问题时返回 null（空串 = 清空，不是错误）。
 */
export function checkNickname(raw) {
  if (typeof raw !== 'string') return '昵称必须是文本';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(raw)) return '昵称不能包含换行或控制字符';
  const value = raw.trim();
  if (!value) return null;
  if (Array.from(value).length > NICKNAME_MAX_LENGTH) return `昵称最多 ${NICKNAME_MAX_LENGTH} 个字符`;
  return null;
}

/**
 * 居中裁剪成正方形时，该从源图上取哪一块。
 * 头像位是方的，直接把长方形压进去会把人脸拉变形，所以取中间最大的正方形。
 */
export function squareCropOf(width, height) {
  const side = Math.min(width, height);
  return { sx: (width - side) / 2, sy: (height - side) / 2, side };
}

/** 选中的文件能不能当头像。返回错误文案或 null。 */
export function checkSourceFile(file) {
  if (!file) return '没有选中文件';
  if (file.type && !ACCEPTED_SOURCE_TYPES.includes(file.type)) {
    return '只支持 PNG / JPEG / WebP / GIF / BMP 图片';
  }
  if (file.size > MAX_SOURCE_BYTES) {
    return `图片不能超过 ${Math.floor(MAX_SOURCE_BYTES / 1024 / 1024)}MB`;
  }
  return null;
}

/** 默认的图片加载：object URL → <img>，用完立刻释放。 */
function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
    img.src = url;
  });
}

function createDomCanvas(size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

/**
 * 把用户选的图压成可以直接 PATCH 上去的头像 data URI：居中裁方 → 缩到 AVATAR_SIZE → 重编码。
 *
 * 一律重编码而不是原样上传，有三个好处：尺寸可控（服务端 256KB 的闸门基本碰不到）、
 * 格式收敛成 JPEG（服务端白名单里的一种）、顺带把原图的 EXIF 之类元数据丢掉。
 *
 * JPEG 不带透明通道，所以先铺一层底色再画 —— 不铺的话透明区域会变成黑块。
 *
 * loadImage / createCanvas 可注入：jsdom 里没有真的 canvas，测试要从这两处接管。
 */
export async function fileToAvatarDataUrl(file, options = {}) {
  const {
    size = AVATAR_SIZE,
    mimeType = AVATAR_MIME,
    quality = AVATAR_QUALITY,
    background = '#ffffff',
    loadImage = loadImageFromFile,
    createCanvas = createDomCanvas,
  } = options;

  const fileError = checkSourceFile(file);
  if (fileError) throw new Error(fileError);

  const img = await loadImage(file);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (!width || !height) throw new Error('图片解码失败');

  const { sx, sy, side } = squareCropOf(width, height);
  const canvas = createCanvas(size);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持图片处理');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);

  return canvas.toDataURL(mimeType, quality);
}
