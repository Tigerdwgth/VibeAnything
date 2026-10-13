// 桌面版行内提示（替掉 alert）。
//
// 为什么这块值得测：alert 的坏处是**阻塞整页**（Dashboard 是开一整天的工具，终端还在出字），
// 换成行内提示之后，新的风险变成「提示自己不消失」或「同一条错误刷屏」——
// 重连时 relay 会把同一条 folder_error 反复推下来。所以这里盯三件事：
// 自动消失、同文案去重、能手动点掉。
//
// 用真组件 + 真 hook，只把定时器换成假的。

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import useNotices, { SUCCESS_MS, ERROR_MS } from '../src/useNotices.js';
import NoticeStack from '../src/NoticeStack.jsx';
import { ThemeContext, DARK } from '../src/theme.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host;
let root;
let api;      // 当前渲染出的 { notify, dismiss, notices }

/**
 * 一个最小宿主：把 hook 暴露给测试，同时渲染真正的提示容器。
 * 导出动作放在 effect 里而不是 render 里 —— render 阶段写外部变量是副作用。
 */
function Harness({ onReady }) {
  const notices = useNotices();
  useEffect(() => { onReady(notices); });
  return <NoticeStack notices={notices.notices} onDismiss={notices.dismiss} />;
}

const render = () => act(() => {
  root.render(
    <ThemeContext.Provider value={DARK}>
      <Harness onReady={(value) => { api = value; }} />
    </ThemeContext.Provider>
  );
});
const texts = () => Array.from(host.querySelectorAll('[role="status"]')).map(el => el.textContent);
const click = (el) => act(() => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  render();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

test('没有提示时什么都不渲染（不留一个占位容器挡住终端右下角）', () => {
  expect(host.innerHTML).toBe('');
});

test('推一条就显示出来', () => {
  act(() => { api.notify('重命名失败：已存在同名会话'); });
  expect(texts()).toEqual(['重命名失败：已存在同名会话']);
});

test('普通提示 3 秒后自己消失', () => {
  act(() => { api.notify('已粘贴到终端'); });
  act(() => { vi.advanceTimersByTime(SUCCESS_MS - 1); });
  expect(texts()).toHaveLength(1);
  act(() => { vi.advanceTimersByTime(2); });
  expect(texts()).toHaveLength(0);
});

test('错误留得久一些 —— 够看清为什么失败', () => {
  act(() => { api.notify('文件夹操作失败：无权操作该文件夹', 'error'); });
  act(() => { vi.advanceTimersByTime(SUCCESS_MS + 100); });
  expect(texts()).toHaveLength(1);
  act(() => { vi.advanceTimersByTime(ERROR_MS); });
  expect(texts()).toHaveLength(0);
});

test('同一条文案重复推只留一条，并把计时重置（重连会把同一个错反复推下来）', () => {
  act(() => { api.notify('无权操作该文件夹', 'error'); });
  act(() => { vi.advanceTimersByTime(ERROR_MS - 500); });
  act(() => { api.notify('无权操作该文件夹', 'error'); });
  expect(texts()).toEqual(['无权操作该文件夹']);
  // 若没有重置计时，这一刻它已经消失了
  act(() => { vi.advanceTimersByTime(600); });
  expect(texts()).toHaveLength(1);
  act(() => { vi.advanceTimersByTime(ERROR_MS); });
  expect(texts()).toHaveLength(0);
});

test('不同文案各自一条，按先后堆着', () => {
  act(() => { api.notify('第一条'); api.notify('第二条', 'error'); });
  expect(texts()).toEqual(['第一条', '第二条']);
});

test('点一下就关掉那一条，不动别的', () => {
  act(() => { api.notify('留着的'); api.notify('要关的', 'error'); });
  click(Array.from(host.querySelectorAll('[role="status"]')).find(el => el.textContent === '要关的'));
  expect(texts()).toEqual(['留着的']);
});

test('空文案不产生提示（msg.error 为空时不该弹一个空框）', () => {
  act(() => { api.notify(''); api.notify('   '); api.notify(null); });
  expect(texts()).toHaveLength(0);
});

test('常驻提示不自动消失（「有新版本」不该几秒就溜走）', () => {
  act(() => { api.notify('前端有新版本已上线', 'info', { sticky: true, actionLabel: '刷新', onAction: () => {} }); });
  act(() => { vi.advanceTimersByTime(ERROR_MS * 3); });
  expect(texts().some(t => t.includes('前端有新版本已上线'))).toBe(true);
});

test('常驻提示的整块不可点，只有动作按钮和 ✕ 可点 —— 手一抖不该把页面刷了', () => {
  let refreshed = 0;
  act(() => { api.notify('前端有新版本已上线', 'info', { sticky: true, actionLabel: '刷新', onAction: () => { refreshed += 1; } }); });
  const card = host.querySelector('[role="status"]');
  click(card);
  expect(refreshed).toBe(0);
  expect(texts()).toHaveLength(1);                 // 点整块既不执行动作也不关掉

  click(Array.from(card.querySelectorAll('button')).find(b => b.textContent === '刷新'));
  expect(refreshed).toBe(1);

  click(card.querySelector('button[aria-label="关闭提示"]'));
  expect(texts()).toHaveLength(0);
});

test('容器不吃鼠标事件，只有提示本身能点 —— 否则会挡住下面终端的右下角', () => {
  act(() => { api.notify('x'); });
  const container = host.firstElementChild;
  expect(container.style.pointerEvents).toBe('none');
  expect(host.querySelector('[role="status"]').style.pointerEvents).toBe('auto');
});
