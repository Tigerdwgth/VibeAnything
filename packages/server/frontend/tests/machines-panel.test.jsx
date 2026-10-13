// 开发机面板（管理员）：台账渲染、签发邀请码、换 token、撤销。
//
// 渲染真组件、点真按钮，替身只有 fetch（宿主 API）。断言的重点是装机那一刻
// 人要看到什么：码只显示一次、照着贴的命令里带对的服务器地址和机器名占位，
// 以及**页面上任何地方都不该出现机器的 token**（列表接口压根不返回它）。

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import MachinesPanel from '../src/MachinesPanel.jsx';
import { ThemeContext, DARK } from '../src/theme.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host;
let root;
let calls;
let origFetch;

const LEDGER = {
  machines: [
    { machineId: 'macmini', label: '主力开发机', createdBy: 'admin', createdAt: 1, lastSeen: Date.now() - 60_000, online: true },
    { machineId: 'gpu-4090-05', label: null, createdBy: 'admin', createdAt: 1, lastSeen: null, online: false },
  ],
  legacyMachines: [{ machineId: 'gpuserver1-jdh' }],
  pendingInvites: [],
};

/** 按 URL+方法派发的 fetch 替身；记录每次调用，供断言请求体。 */
function installFetch(routes) {
  calls = [];
  globalThis.fetch = vi.fn(async (url, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ url, method, body: options.body ? JSON.parse(options.body) : null, headers: options.headers });
    const key = `${method} ${url}`;
    const route = routes[key];
    if (!route) throw new Error(`没有为 ${key} 准备响应`);
    return { ok: route.status === undefined || route.status < 400, status: route.status || 200, json: async () => route.body };
  });
}

const render = () => act(() => {
  root.render(
    <ThemeContext.Provider value={DARK}>
      <MachinesPanel token="jwt-admin" onClose={() => {}} />
    </ThemeContext.Provider>
  );
});

const buttons = () => Array.from(host.querySelectorAll('button'));
const byText = (t) => buttons().find(b => b.textContent === t);
const click = (el) => act(() => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
const flush = () => act(async () => { await Promise.resolve(); });

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  origFetch = globalThis.fetch;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

describe('台账', () => {
  test('打开就拉台账，带上管理员的 token', async () => {
    installFetch({ 'GET /api/machines': { body: LEDGER } });
    render();
    await flush();
    expect(calls[0].url).toBe('/api/machines');
    expect(calls[0].headers.Authorization).toBe('Bearer jwt-admin');
  });

  test('每台机器显示名字、备注、在线状态与多久没见过', async () => {
    installFetch({ 'GET /api/machines': { body: LEDGER } });
    render();
    await flush();
    expect(host.textContent).toContain('macmini');
    expect(host.textContent).toContain('主力开发机');
    expect(host.textContent).toContain('1 分钟前');
    expect(host.textContent).toContain('gpu-4090-05');
    expect(host.textContent).toContain('从未连接');
  });

  test('还在用旧全局 token 的机器单独列出来，能一键发码换装', async () => {
    installFetch({ 'GET /api/machines': { body: LEDGER } });
    render();
    await flush();
    expect(host.textContent).toContain('gpuserver1-jdh');
    expect(byText('发码换装')).toBeTruthy();
  });

  test('台账空着时给的是下一步动作，不是一片空白', async () => {
    installFetch({ 'GET /api/machines': { body: { machines: [], legacyMachines: [], pendingInvites: [] } } });
    render();
    await flush();
    expect(host.textContent).toContain('添加开发机');
    expect(host.textContent).toMatch(/还没有机器/);
  });

  test('读取失败时说清楚，而不是一直停在「读取中」', async () => {
    installFetch({ 'GET /api/machines': { status: 403, body: { error: '需要管理员权限' } } });
    render();
    await flush();
    expect(host.textContent).toContain('需要管理员权限');
  });
});

describe('签发邀请码', () => {
  const INVITE = { code: 'vai_ABC123', expiresAt: Date.now() + 1_800_000, machineId: null };

  test('＋ 添加开发机 → 显示码 + 照着贴的两条命令（带本站地址与机器名占位）', async () => {
    installFetch({
      'GET /api/machines': { body: LEDGER },
      'POST /api/machines/invite': { body: INVITE },
    });
    render();
    await flush();
    click(byText('＋ 添加开发机'));
    await flush();

    expect(calls[1].body).toEqual({ machineId: null, label: null });
    expect(host.textContent).toContain('vai_ABC123');
    const pre = host.querySelector('pre').textContent;
    expect(pre).toContain(`vibeanything join --server ${location.origin} --code vai_ABC123`);
    expect(pre).toContain('--machine-id <这台机器的名字>');
    expect(pre).toContain('vibeanything service install');
    expect(host.textContent).toMatch(/只显示这一次/);
  });

  test('备注填了就带上去（列表里靠它认人）', async () => {
    installFetch({
      'GET /api/machines': { body: LEDGER },
      'POST /api/machines/invite': { body: INVITE },
    });
    render();
    await flush();
    const input = host.querySelector('input[aria-label="新机器备注"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    act(() => {
      setter.call(input, '实验室 4090');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    click(byText('＋ 添加开发机'));
    await flush();
    expect(calls[1].body).toEqual({ machineId: null, label: '实验室 4090' });
  });

  test('给已有机器「换 token」时带上 machineId —— 这是唯一能顶掉已登记机器的途径', async () => {
    installFetch({
      'GET /api/machines': { body: LEDGER },
      'POST /api/machines/invite': { body: { ...INVITE, machineId: 'macmini' } },
    });
    render();
    await flush();
    click(buttons().find(b => b.textContent === '换 token'));
    await flush();
    expect(calls[1].body).toEqual({ machineId: 'macmini', label: null });
    // 指名的码不需要再填机器名，命令里不该留占位
    expect(host.querySelector('pre').textContent).not.toContain('--machine-id <');
    expect(host.textContent).toContain('仅限 macmini');
  });

  test('签发失败只提示，不显示一个假码', async () => {
    installFetch({
      'GET /api/machines': { body: LEDGER },
      'POST /api/machines/invite': { status: 500, body: { error: '签发失败' } },
    });
    render();
    await flush();
    click(byText('＋ 添加开发机'));
    await flush();
    expect(host.textContent).toContain('签发失败');
    expect(host.querySelector('pre')).toBeNull();
  });
});

describe('撤销', () => {
  test('要先确认；点取消就什么都不发', async () => {
    installFetch({ 'GET /api/machines': { body: LEDGER } });
    const real = window.confirm;
    try {
      window.confirm = () => false;
      render();
      await flush();
      click(buttons().find(b => b.textContent === '撤销'));
      await flush();
      expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(0);
    } finally {
      window.confirm = real;
    }
  });

  test('确认后发 DELETE，并重新拉一遍台账', async () => {
    installFetch({
      'GET /api/machines': { body: LEDGER },
      'DELETE /api/machines/macmini': { body: { ok: true, machineId: 'macmini', disconnected: true } },
    });
    const real = window.confirm;
    try {
      window.confirm = () => true;
      render();
      await flush();
      click(buttons().find(b => b.textContent === '撤销'));
      await flush();
      const del = calls.find(c => c.method === 'DELETE');
      expect(del.url).toBe('/api/machines/macmini');
      expect(calls.filter(c => c.url === '/api/machines' && c.method === 'GET')).toHaveLength(2);
    } finally {
      window.confirm = real;
    }
  });
});

describe('不泄露凭据', () => {
  test('页面上不出现任何 machineToken —— 列表接口本来就不返回它', async () => {
    installFetch({ 'GET /api/machines': { body: LEDGER } });
    render();
    await flush();
    expect(host.innerHTML).not.toContain('vamt_');
  });
});
