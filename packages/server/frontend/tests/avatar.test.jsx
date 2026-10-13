// 头像组件。逻辑只有一条但必须成立：自定义头像显示不出来时退回默认图。
//
// 这条在浏览器里靠 <img> 的 error 事件触发，测试里派发的就是真的 error 事件
// （jsdom 不会真去加载 src，所以那个事件本来也只能由测试来发）。

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import Avatar from '../src/Avatar.jsx';
import { DEFAULT_AVATAR } from '../src/profile.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const A = 'data:image/jpeg;base64,AAAA';
const B = 'data:image/jpeg;base64,BBBB';

let host;
let root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (profile, props) => act(() => root.render(<Avatar profile={profile} {...props} />));
const img = () => host.querySelector('img');
const fireError = () => act(() => img().dispatchEvent(new window.Event('error', { bubbles: false })));

describe('Avatar', () => {
  test('没设过头像 → 站点默认图', () => {
    render({ username: 'laoyonghu', avatar: null });
    expect(img().getAttribute('src')).toBe(DEFAULT_AVATAR);
  });

  test('设过头像 → 自己的图', () => {
    render({ username: 'laoyonghu', avatar: A });
    expect(img().getAttribute('src')).toBe(A);
  });

  test('自定义头像加载失败 → 退回默认图，而不是挂一个裂图', () => {
    render({ username: 'laoyonghu', avatar: A });
    fireError();
    expect(img().getAttribute('src')).toBe(DEFAULT_AVATAR);
  });

  test('换一张新头像后要重新给它机会 —— 上一张失败不能把后面所有的都压住', () => {
    render({ username: 'laoyonghu', avatar: A });
    fireError();
    expect(img().getAttribute('src')).toBe(DEFAULT_AVATAR);

    render({ username: 'laoyonghu', avatar: B });
    expect(img().getAttribute('src')).toBe(B);
  });

  test('默认图自己也加载不出来时不会打转（src 已经是默认图，不再换）', () => {
    render({ username: 'laoyonghu', avatar: null });
    fireError();
    expect(img().getAttribute('src')).toBe(DEFAULT_AVATAR);
  });

  test('alt 用显示名，读屏能念出是谁', () => {
    render({ username: 'laoyonghu', nickname: '阿杰', avatar: A });
    expect(img().getAttribute('alt')).toBe('阿杰');
    render({ username: 'laoyonghu', nickname: null, avatar: A });
    expect(img().getAttribute('alt')).toBe('laoyonghu');
  });

  test('尺寸与圆角按调用方给的来（侧边栏 22px 圆形、弹窗 88px）', () => {
    render({ username: 'u', avatar: A }, { size: 88, radius: '50%' });
    expect(img().style.width).toBe('88px');
    expect(img().style.height).toBe('88px');
    expect(img().style.borderRadius).toBe('50%');
  });
});
