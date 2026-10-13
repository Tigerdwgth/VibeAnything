// 个人信息的前端纯逻辑：显示回落规则 + 把用户选的图压成头像 data URI。
//
// 压图那部分的 loadImage / createCanvas 是注入进去的 —— jsdom 里没有真 canvas
// （setup-jsdom 那个假 2d context 只够 xterm 量字宽，没有 drawImage，也没有 toDataURL）。
// 替身刻意保留了被测代码真正依赖的那几条性质：drawImage 收九参、toDataURL 收
// (mime, quality)、fillRect 与 drawImage 的先后顺序 —— 断言就压在这些性质上。

import { describe, test, expect } from 'vitest';
import {
  DEFAULT_AVATAR, NICKNAME_MAX_LENGTH, AVATAR_SIZE, AVATAR_MIME, AVATAR_QUALITY, MAX_SOURCE_BYTES,
  displayNameOf, avatarSrcOf, usesDefaultAvatar, checkNickname,
  squareCropOf, checkSourceFile, fileToAvatarDataUrl,
} from '../src/profile.js';

/** 记录每一次调用的假 canvas。复刻的是浏览器 canvas 的调用契约，不是期望的结果。 */
function makeFakeCanvas() {
  const calls = [];
  const ctx = {
    set fillStyle(v) { calls.push(['fillStyle', v]); },
    fillRect: (...a) => calls.push(['fillRect', ...a]),
    drawImage: (...a) => calls.push(['drawImage', ...a]),
  };
  const canvas = {
    width: 0, height: 0,
    getContext: (type) => (type === '2d' ? ctx : null),
    toDataURL: (mime, quality) => { calls.push(['toDataURL', mime, quality]); return `data:${mime};base64,FAKE`; },
  };
  return { canvas, calls, create: (size) => { canvas.width = size; canvas.height = size; return canvas; } };
}

const fakeImage = (w, h) => ({ naturalWidth: w, naturalHeight: h });
const fakeFile = (type = 'image/png', size = 1024) => ({ type, size, name: 'a.png' });

// ── 显示回落 ──────────────────────────────────────────────────

describe('displayNameOf', () => {
  test('设过昵称就用昵称', () => {
    expect(displayNameOf({ username: 'laoyonghu', nickname: '阿杰' })).toBe('阿杰');
  });

  test('没设过 / 空 / 纯空白 都退回用户名', () => {
    for (const nickname of [null, undefined, '', '   ']) {
      expect(displayNameOf({ username: 'laoyonghu', nickname })).toBe('laoyonghu');
    }
  });

  test('两端空白不算进昵称', () => {
    expect(displayNameOf({ username: 'u', nickname: '  阿杰  ' })).toBe('阿杰');
  });

  test('什么都没有时给空串，不给 undefined（要直接渲染进 DOM）', () => {
    expect(displayNameOf(null)).toBe('');
    expect(displayNameOf({})).toBe('');
  });
});

describe('avatarSrcOf', () => {
  test('设过头像就用自己的', () => {
    expect(avatarSrcOf({ avatar: 'data:image/jpeg;base64,AAA' })).toBe('data:image/jpeg;base64,AAA');
  });

  test('没设过退回站点默认图 —— 就是侧边栏左上角那只兔子', () => {
    expect(DEFAULT_AVATAR).toBe('/usagi.png');
    expect(avatarSrcOf({ avatar: null })).toBe(DEFAULT_AVATAR);
    expect(avatarSrcOf(null)).toBe(DEFAULT_AVATAR);
  });

  test('usesDefaultAvatar 与之一致（「恢复默认」按钮靠它决定能不能点）', () => {
    expect(usesDefaultAvatar({ avatar: null })).toBe(true);
    expect(usesDefaultAvatar({ avatar: 'data:image/png;base64,AAA' })).toBe(false);
  });
});

// ── 昵称预检 ──────────────────────────────────────────────────

describe('checkNickname', () => {
  test('正常昵称与空串都放行（空串 = 清空）', () => {
    expect(checkNickname('阿杰')).toBe(null);
    expect(checkNickname('')).toBe(null);
    expect(checkNickname('   ')).toBe(null);
  });

  test(`超过 ${NICKNAME_MAX_LENGTH} 个字符给出提示`, () => {
    expect(checkNickname('x'.repeat(NICKNAME_MAX_LENGTH))).toBe(null);
    expect(checkNickname('x'.repeat(NICKNAME_MAX_LENGTH + 1))).toMatch(/昵称/);
  });

  test('按码点算长度：24 个 emoji 合法（.length 是 48）', () => {
    const emoji = '🐰'.repeat(NICKNAME_MAX_LENGTH);
    expect(emoji.length).toBe(NICKNAME_MAX_LENGTH * 2);
    expect(checkNickname(emoji)).toBe(null);
  });

  test('换行与控制字符拒绝', () => {
    expect(checkNickname('a\nb')).toMatch(/控制字符/);
    expect(checkNickname('a\u0000b')).toMatch(/控制字符/);
  });
});

// ── 裁剪几何 ──────────────────────────────────────────────────

describe('squareCropOf', () => {
  test('横图取中间那一方块', () => {
    expect(squareCropOf(1000, 400)).toEqual({ sx: 300, sy: 0, side: 400 });
  });

  test('竖图同理，偏移落在 y 上', () => {
    expect(squareCropOf(400, 1000)).toEqual({ sx: 0, sy: 300, side: 400 });
  });

  test('本来就是方的就不动它', () => {
    expect(squareCropOf(512, 512)).toEqual({ sx: 0, sy: 0, side: 512 });
  });
});

// ── 选图闸门 ──────────────────────────────────────────────────

describe('checkSourceFile', () => {
  test('受支持的图片放行', () => {
    expect(checkSourceFile(fakeFile('image/jpeg'))).toBe(null);
    expect(checkSourceFile(fakeFile('image/webp'))).toBe(null);
  });

  test('SVG 不收（能带脚本）', () => {
    expect(checkSourceFile(fakeFile('image/svg+xml'))).toMatch(/只支持/);
  });

  test('非图片不收', () => {
    expect(checkSourceFile(fakeFile('application/pdf'))).toMatch(/只支持/);
  });

  test('超大原图在解码之前就拦下来，别把浏览器卡死', () => {
    expect(checkSourceFile(fakeFile('image/png', MAX_SOURCE_BYTES + 1))).toMatch(/MB/);
  });

  test('没选文件', () => {
    expect(checkSourceFile(null)).toMatch(/没有选中/);
  });
});

// ── 压图 ──────────────────────────────────────────────────────

describe('fileToAvatarDataUrl', () => {
  test('横图：从源图中间取正方形，画成 AVATAR_SIZE 见方', async () => {
    const fake = makeFakeCanvas();
    await fileToAvatarDataUrl(fakeFile(), {
      loadImage: async () => fakeImage(1000, 400),
      createCanvas: fake.create,
    });
    const draw = fake.calls.find(c => c[0] === 'drawImage');
    // drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
    expect(draw.slice(2)).toEqual([300, 0, 400, 400, 0, 0, AVATAR_SIZE, AVATAR_SIZE]);
    expect(fake.canvas.width).toBe(AVATAR_SIZE);
    expect(fake.canvas.height).toBe(AVATAR_SIZE);
  });

  test('竖图：偏移落在 y 上', async () => {
    const fake = makeFakeCanvas();
    await fileToAvatarDataUrl(fakeFile(), {
      loadImage: async () => fakeImage(400, 1000),
      createCanvas: fake.create,
    });
    expect(fake.calls.find(c => c[0] === 'drawImage').slice(2, 6)).toEqual([0, 300, 400, 400]);
  });

  test('按 AVATAR_MIME / AVATAR_QUALITY 重编码 —— 落库格式必须落在服务端白名单里', async () => {
    const fake = makeFakeCanvas();
    const out = await fileToAvatarDataUrl(fakeFile(), {
      loadImage: async () => fakeImage(512, 512),
      createCanvas: fake.create,
    });
    expect(fake.calls.find(c => c[0] === 'toDataURL')).toEqual(['toDataURL', AVATAR_MIME, AVATAR_QUALITY]);
    expect(out).toBe(`data:${AVATAR_MIME};base64,FAKE`);
  });

  test('先铺底色再画图：JPEG 没有透明通道，不铺的话透明区域会变成黑块', async () => {
    const fake = makeFakeCanvas();
    await fileToAvatarDataUrl(fakeFile(), {
      loadImage: async () => fakeImage(512, 512),
      createCanvas: fake.create,
    });
    const order = fake.calls.map(c => c[0]);
    expect(order.indexOf('fillRect')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('fillRect')).toBeLessThan(order.indexOf('drawImage'));
  });

  test('读到 0 尺寸的图当解码失败处理，不能悄悄产出一张空白头像', async () => {
    const fake = makeFakeCanvas();
    await expect(fileToAvatarDataUrl(fakeFile(), {
      loadImage: async () => fakeImage(0, 0),
      createCanvas: fake.create,
    })).rejects.toThrow(/解码失败/);
  });

  test('不受支持的文件在加载之前就被拒，不会白解码一次', async () => {
    let loaded = false;
    await expect(fileToAvatarDataUrl(fakeFile('image/svg+xml'), {
      loadImage: async () => { loaded = true; return fakeImage(10, 10); },
      createCanvas: makeFakeCanvas().create,
    })).rejects.toThrow(/只支持/);
    expect(loaded).toBe(false);
  });

  test('拿不到 2d context 时给出人能看懂的错，而不是 TypeError', async () => {
    await expect(fileToAvatarDataUrl(fakeFile(), {
      loadImage: async () => fakeImage(512, 512),
      createCanvas: () => ({ getContext: () => null }),
    })).rejects.toThrow(/不支持图片处理/);
  });
});
