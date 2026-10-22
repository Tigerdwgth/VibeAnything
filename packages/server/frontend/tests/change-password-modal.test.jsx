// 改密码成功后，服务端会让所有旧票作废并给当前设备补发新票：弹窗必须把新票交出去，
// 否则本设备紧接着就会因为旧票失效而被踢下线。

import { test, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import ChangePasswordModal from '../src/ChangePasswordModal.jsx';
import { ThemeContext, DARK } from '../src/theme.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host;
let root;
let origFetch;
let request;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  origFetch = globalThis.fetch;
  localStorage.setItem('token', 'old-token');
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.fetch = origFetch;
});

/** React 受控输入要走原生 setter + input 事件，直接改 value 它不认。 */
function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

async function submitForm({ response, onSuccess }) {
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return response;
  };
  act(() => {
    root.render(
      <ThemeContext.Provider value={DARK}>
        <ChangePasswordModal onClose={() => {}} onSuccess={onSuccess} />
      </ThemeContext.Provider>
    );
  });
  type(host.querySelector('input[name="old-password"]'), 'secret123');
  type(host.querySelector('input[name="new-password"]'), 'newsecret789');
  type(host.querySelector('input[name="confirm-password"]'), 'newsecret789');
  await act(async () => {
    host.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
}

test('成功：把服务端补发的新票交给 onSuccess', async () => {
  const got = [];
  await submitForm({
    response: { ok: true, status: 200, json: async () => ({ success: true, token: 'fresh-token' }) },
    onSuccess: (t) => got.push(t),
  });
  expect(request.url).toBe('/api/change-password');
  expect(request.init.headers.Authorization).toBe('Bearer old-token');
  expect(JSON.parse(request.init.body)).toEqual({ oldPassword: 'secret123', newPassword: 'newsecret789' });
  expect(got).toEqual(['fresh-token']);
});

test('失败（旧密码错）：不调 onSuccess，显示服务端的错误', async () => {
  const got = [];
  await submitForm({
    response: { ok: false, status: 401, json: async () => ({ error: '旧密码错误' }) },
    onSuccess: (t) => got.push(t),
  });
  expect(got).toEqual([]);
  expect(host.textContent).toContain('旧密码错误');
});
