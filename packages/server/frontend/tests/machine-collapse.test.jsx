import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, test, expect } from 'vitest';
import SessionTabs from '../src/SessionTabs.jsx';
import { ThemeContext, DARK } from '../src/theme.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host, root, calls;
const sessions = [
  { machineId: 'one', sessionId: 'first', cwd: '/work', folderId: 'f', isRunning: true },
  { machineId: 'two', sessionId: 'second', cwd: '/work', isRunning: false },
];
function render(activeSessions = sessions) {
  act(() => root.render(<ThemeContext.Provider value={DARK}>
    <SessionTabs activeSessions={activeSessions} historySessions={[]} openTerminals={[]}
      active={{ machineId: 'one', sessionId: 'first' }}
      foldersByMachine={{ one: [{ id: 'f', name: '项目', parentId: null }] }}
      onCreateFolder={(...args) => calls.push(args)} />
  </ThemeContext.Provider>));
}
const toggle = mid => [...host.querySelectorAll('button[aria-expanded]')].find(b => b.title === mid);
const click = el => act(() => el.click());
const content = mid => document.getElementById(toggle(mid).getAttribute('aria-controls'));
beforeEach(() => {
  localStorage.clear(); calls = [];
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

test('只折叠指定开发机，保留计数及当前标记，数据刷新不会展开', () => {
  render();
  click(toggle('one'));
  expect(content('one').hidden).toBe(true);
  expect(content('one').querySelector('.sess-item')).toBeNull();
  expect(content('two').hidden).toBe(false);
  expect(toggle('one').textContent).toContain('1 会话');
  expect(toggle('one').textContent).toContain('1 运行中');
  expect(toggle('one').textContent).toContain('当前');
  render([...sessions, { machineId: 'one', sessionId: 'new', cwd: '/tmp' }]);
  expect(toggle('one').getAttribute('aria-expanded')).toBe('false');
  expect(toggle('one').textContent).toContain('2 会话');
  click(toggle('one'));
  expect(content('one').querySelectorAll('.sess-item')).toHaveLength(2);
});

test('重新挂载保留机器和文件夹各自的折叠状态', () => {
  render();
  const folder = [...host.querySelectorAll('[role="button"]')].find(e => e.textContent.includes('项目'));
  click(folder);
  click(toggle('one'));
  act(() => root.unmount()); root = createRoot(host); render();
  expect(content('one').hidden).toBe(true);
  click(toggle('one'));
  expect(content('one').textContent).toContain('项目');
  expect(content('one').querySelector('.sess-item')).toBeNull();
  expect(content('two').querySelector('.sess-item')).not.toBeNull();
});

test('收起时新建文件夹会展开目标机器，回调仍指向目标机器', () => {
  render(); click(toggle('one'));
  click(host.querySelector('[aria-label="在 one 新建文件夹"]'));
  expect(content('one').hidden).toBe(false);
  expect(calls).toEqual([['one', '新文件夹', null]]);
  expect(localStorage.getItem('machineCollapsed:one')).toBe('false');
});
