// 管理员「全部会话」视图按归属人分组：桌面侧边栏 + 手机会话列表。
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, test, expect } from 'vitest';
import SessionTabs from '../src/SessionTabs.jsx';
import MobileSessionList from '../src/mobile/MobileSessionList.jsx';
import { ThemeContext, DARK } from '../src/theme.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host, root, calls;

const SESSIONS = [
  { machineId: 'macmini', sessionId: 'mine', cwd: '/admin-work', owner: 'admin', folderId: 'fa', isRunning: true },
  { machineId: 'macmini', sessionId: 'theirs', cwd: '/proj-work', owner: 'carol', folderId: 'fl', isRunning: false },
  { machineId: 'gpu', sessionId: 'theirs2', cwd: '/proj-gpu', owner: 'carol', isRunning: false },
  { machineId: 'gpu', sessionId: 'orphan', cwd: '/nobody', owner: null, isRunning: false },
];
const FOLDERS = {
  macmini: [
    { id: 'fa', name: '管理员项目', parentId: null, owner: 'admin' },
    { id: 'fl', name: 'carol项目', parentId: null, owner: 'carol' },
  ],
};

beforeEach(() => {
  localStorage.clear(); calls = [];
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function renderDesktop(activeSessions = SESSIONS) {
  act(() => root.render(<ThemeContext.Provider value={DARK}>
    <SessionTabs selfUsername="admin" activeSessions={activeSessions} historySessions={[]} openTerminals={[]}
      active={null} foldersByMachine={FOLDERS}
      onCreateFolder={(...a) => calls.push(a)} />
  </ThemeContext.Provider>));
}
const ownerToggle = label => [...host.querySelectorAll('button.owner-toggle')].find(b => b.textContent.includes(label));
const ownerContent = label => document.getElementById(ownerToggle(label).getAttribute('aria-controls'));

test('桌面：按人分组，自己在前、无主垫底，每组里只有自己的会话和文件夹', () => {
  renderDesktop();
  const headers = [...host.querySelectorAll('button.owner-toggle')].map(b => b.textContent);
  expect(headers).toHaveLength(3);
  expect(headers[0]).toContain('admin（我）');
  expect(headers[1]).toContain('carol');
  expect(headers[1]).toContain('2 会话');
  expect(headers[2]).toContain('无主');

  const mine = ownerContent('admin（我）');
  expect(mine.textContent).toContain('管理员项目');
  expect(mine.textContent).not.toContain('carol项目');
  expect(mine.querySelectorAll('.sess-item')).toHaveLength(1);

  const carol = ownerContent('carol');
  expect(carol.textContent).toContain('carol项目');
  expect(carol.textContent).not.toContain('管理员项目');
  // 同一个人跨两台机器聚在一组
  expect([...carol.querySelectorAll('button.machine-toggle')].map(b => b.title)).toEqual(['macmini', 'gpu']);
  // 组标题已经说明归属，行内不再重复归属徽章
  expect(carol.querySelector('.sess-item').textContent).not.toContain('carol');
});

test('桌面：只能在自己的组里新建文件夹，别人的组不给建（建出来会归到自己名下）', () => {
  renderDesktop();
  expect(ownerContent('admin（我）').querySelector('[aria-label="在 macmini 新建文件夹"]')).not.toBeNull();
  expect(ownerContent('carol').querySelector('[aria-label="在 macmini 新建文件夹"]')).toBeNull();
});

test('桌面：折叠某人的分组，刷新后保持', () => {
  renderDesktop();
  act(() => ownerToggle('carol').click());
  expect(ownerContent('carol').hidden).toBe(true);
  expect(ownerContent('admin（我）').hidden).toBe(false);
  renderDesktop([...SESSIONS, { machineId: 'gpu', sessionId: 'new', cwd: '/x', owner: 'carol' }]);
  expect(ownerToggle('carol').getAttribute('aria-expanded')).toBe('false');
  expect(ownerToggle('carol').textContent).toContain('3 会话');
});

test('桌面：会话没有归属字段（普通用户）时维持按机器显示', () => {
  renderDesktop(SESSIONS.map(({ owner, ...s }) => s));
  expect(host.querySelector('button.owner-toggle')).toBeNull();
  expect([...host.querySelectorAll('button.machine-toggle')].map(b => b.title)).toEqual(['macmini', 'gpu']);
});

test('手机：选中机器上的会话按人分段，段内是各自的文件夹树', () => {
  act(() => root.render(<ThemeContext.Provider value={DARK}>
    <MobileSessionList
      selfUsername="admin"
      machines={[{ machineId: 'macmini', defaultWorkDir: '/' }]} selectedMachine="macmini" onSelectMachine={() => {}}
      sessions={SESSIONS.filter(s => s.machineId === 'macmini')}
      openSessionIds={new Set()} activeSessionId={null}
      folders={FOLDERS.macmini}
      onOpen={() => {}} onCloseTab={() => {}} onStop={() => {}} onCreate={() => {}} onRenameSession={() => {}}
    />
  </ThemeContext.Provider>));
  const text = host.textContent;
  const iMine = text.indexOf('admin（我）');
  const iLyj = text.indexOf('carol');
  expect(iMine).toBeGreaterThan(-1);
  expect(iLyj).toBeGreaterThan(iMine);
  expect(text.indexOf('管理员项目')).toBeGreaterThan(iMine);
  expect(text.indexOf('管理员项目')).toBeLessThan(iLyj);
  expect(text.indexOf('carol项目')).toBeGreaterThan(iLyj);
});
