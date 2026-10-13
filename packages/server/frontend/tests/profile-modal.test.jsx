// 个人信息弹窗的真实接线：输入 → 提交 → 请求体 → 回写。
//
// 只替换 fetch（宿主 API，jsdom 里会真去发网络请求）。ProfileModal / Avatar / profile.js
// 全是真组件真逻辑，事件也都是真派发。
//
// 最要紧的一条是「只提交改动过的字段」：服务端把「没传」和「传了 null」当两件事，
// 前端要是图省事每次都把两个字段一起发，用户只改个昵称就会把头像重传一遍 ——
// 更糟的是 avatar 那一路一旦写成空值，头像会被静默清掉。

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import ProfileModal from '../src/ProfileModal.jsx';
import { ThemeContext, DARK } from '../src/theme.js';
import { DEFAULT_AVATAR } from '../src/profile.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const AVATAR = 'data:image/jpeg;base64,AAAA';

let host;
let root;
let origFetch;
let requests;
let responder;
let closed;
let saved;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  requests = [];
  closed = 0;
  saved = [];
  responder = () => ({ ok: true, body: { username: 'laoyonghu', role: 'user', nickname: '阿杰', avatar: null } });
  origFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, method: options?.method, body: JSON.parse(options?.body || 'null'), headers: options?.headers });
    const { ok, body } = responder();
    return { ok, status: ok ? 200 : 400, json: async () => body };
  };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.fetch = origFetch;
});

function render(profile) {
  act(() => {
    root.render(
      <ThemeContext.Provider value={DARK}>
        <ProfileModal
          token="tok"
          profile={profile}
          onClose={() => { closed += 1; }}
          onSaved={(p) => saved.push(p)}
        />
      </ThemeContext.Provider>
    );
  });
}

const nicknameInput = () => host.querySelector('#profile-nickname');
const avatarImg = () => host.querySelector('img');
const buttonByText = (text) => Array.from(host.querySelectorAll('button')).find(b => b.textContent.includes(text));
const submitButton = () => host.querySelector('button[type="submit"]');

/** 按 React 认得的方式改输入框：直接改 .value 不会触发 onChange。 */
function typeInto(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    host.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
}

// ── 初始状态 ──────────────────────────────────────────────────

describe('打开时的状态', () => {
  test('昵称输入框预填当前昵称，头像显示当前头像', () => {
    render({ username: 'laoyonghu', nickname: '阿杰', avatar: AVATAR });
    expect(nicknameInput().value).toBe('阿杰');
    expect(avatarImg().getAttribute('src')).toBe(AVATAR);
  });

  test('没设过头像时显示站点默认图，且「恢复默认头像」点不动', () => {
    render({ username: 'laoyonghu', nickname: null, avatar: null });
    expect(avatarImg().getAttribute('src')).toBe(DEFAULT_AVATAR);
    expect(buttonByText('恢复默认头像').disabled).toBe(true);
  });

  test('没设过昵称时输入框为空，占位符提示会显示用户名', () => {
    render({ username: 'laoyonghu', nickname: null, avatar: null });
    expect(nicknameInput().value).toBe('');
    expect(nicknameInput().placeholder).toBe('laoyonghu');
  });

  test('什么都没改时保存按钮是禁用的', () => {
    render({ username: 'laoyonghu', nickname: '阿杰', avatar: AVATAR });
    expect(submitButton().disabled).toBe(true);
  });
});

// ── 提交的请求体 ──────────────────────────────────────────────

describe('提交', () => {
  test('只改昵称时请求体里只有 nickname —— 不把几十 KB 的头像再传一遍', async () => {
    render({ username: 'laoyonghu', nickname: '阿杰', avatar: AVATAR });
    typeInto(nicknameInput(), '老杰');
    await submit();

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('/api/profile');
    expect(requests[0].method).toBe('PATCH');
    expect(requests[0].body).toEqual({ nickname: '老杰' });
  });

  test('昵称删空 = 传 null（服务端据此清空并回落用户名）', async () => {
    render({ username: 'laoyonghu', nickname: '阿杰', avatar: null });
    typeInto(nicknameInput(), '');
    await submit();
    expect(requests[0].body).toEqual({ nickname: null });
  });

  test('点「恢复默认头像」只提交 avatar: null，不动昵称', async () => {
    render({ username: 'laoyonghu', nickname: '阿杰', avatar: AVATAR });
    act(() => buttonByText('恢复默认头像').click());
    expect(avatarImg().getAttribute('src')).toBe(DEFAULT_AVATAR);  // 先在预览上看到
    await submit();
    expect(requests[0].body).toEqual({ avatar: null });
  });

  test('带上 Bearer token', async () => {
    render({ username: 'laoyonghu', nickname: null, avatar: null });
    typeInto(nicknameInput(), '阿杰');
    await submit();
    expect(requests[0].headers.Authorization).toBe('Bearer tok');
  });

  test('保存成功：把服务端回的 profile 交回去，然后关窗', async () => {
    render({ username: 'laoyonghu', nickname: null, avatar: null });
    typeInto(nicknameInput(), '阿杰');
    await submit();
    expect(saved).toEqual([{ username: 'laoyonghu', role: 'user', nickname: '阿杰', avatar: null }]);
    expect(closed).toBe(1);
  });

  test('没有任何改动时提交不发请求，直接关窗', async () => {
    render({ username: 'laoyonghu', nickname: '阿杰', avatar: AVATAR });
    await submit();
    expect(requests).toHaveLength(0);
    expect(closed).toBe(1);
  });
});

// ── 失败路径 ──────────────────────────────────────────────────

describe('失败时要说话', () => {
  test('服务端拒绝：原样显示服务端的错误文案，窗不关、不回写', async () => {
    responder = () => ({ ok: false, body: { error: '昵称最多 24 个字符' } });
    render({ username: 'laoyonghu', nickname: null, avatar: null });
    typeInto(nicknameInput(), '阿杰');
    await submit();

    expect(host.textContent).toContain('昵称最多 24 个字符');
    expect(closed).toBe(0);
    expect(saved).toEqual([]);
  });

  test('网络断了也要有出口，不能点了没反应', async () => {
    globalThis.fetch = async () => { throw new Error('offline'); };
    render({ username: 'laoyonghu', nickname: null, avatar: null });
    typeInto(nicknameInput(), '阿杰');
    await submit();

    expect(host.textContent).toContain('连接服务器失败');
    expect(closed).toBe(0);
  });

  test('昵称超长时保存按钮禁用，提交也不会发请求', async () => {
    render({ username: 'laoyonghu', nickname: null, avatar: null });
    typeInto(nicknameInput(), 'x'.repeat(30));
    expect(submitButton().disabled).toBe(true);
    await submit();
    expect(requests).toHaveLength(0);
    expect(host.textContent).toContain('昵称最多');
  });
});
