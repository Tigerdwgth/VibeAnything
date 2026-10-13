// 手机版会话列表：机器选择、红绿灯、打开 / 关闭 / 停止、新建会话。
// 渲染真组件、点真按钮，断言的是「点下去到底调了什么、带了什么参数」——
// 参数错了（比如新建会话没带 cwd）页面看起来一切正常，终端却开在错的目录里。

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import MobileSessionList from '../src/mobile/MobileSessionList.jsx';
import { DARK } from '../src/theme.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host;
let root;
let calls;

const MACHINES = [
  { machineId: 'macmini', defaultWorkDir: '/Users/gsj', sessionCount: 2 },
  { machineId: 'gpuserver1', defaultWorkDir: '/home/jdh', sessionCount: 1 },
];

const SESSIONS = [
  { machineId: 'macmini', sessionId: 'cc-abc', cwd: '/Users/gsj/VibeAnything', isRunning: true, mtime: new Date().toISOString() },
  { machineId: 'macmini', sessionId: 'my-shell', cwd: '/Users/gsj/tmp', isRunning: false, mtime: new Date().toISOString() },
];

function render(overrides = {}) {
  const props = {
    machines: MACHINES,
    selectedMachine: 'macmini',
    onSelectMachine: (m) => calls.push(['machine', m]),
    sessions: SESSIONS,
    openSessionIds: new Set(['my-shell']),
    activeSessionId: 'my-shell',
    onOpen: (...a) => calls.push(['open', ...a]),
    onCloseTab: (...a) => calls.push(['close', ...a]),
    onStop: (...a) => calls.push(['stop', ...a]),
    onCreate: (...a) => calls.push(['create', ...a]),
    onRenameSession: (...a) => calls.push(['renameSession', ...a]),
    ...overrides,
  };
  act(() => { root.render(<MobileSessionList {...props} />); });
}

const buttons = () => Array.from(host.querySelectorAll('button'));
const byText = (t) => buttons().find(b => b.textContent === t);
const click = (el) => act(() => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });

/** 一行会话 = 带 borderLeft 的那层 div，用它显示的 cwd 定位（cwd 在列表里唯一）。 */
function row(cwd) {
  const el = Array.from(host.querySelectorAll('div')).find(d => (
    d.style.borderLeft && d.textContent.includes(cwd)
  ));
  if (!el) throw new Error(`找不到 cwd 为「${cwd}」的会话行`);
  return el;
}

const RUNNING_ROW = '/Users/gsj/VibeAnything';   // cc-abc，红灯
const IDLE_ROW = '/Users/gsj/tmp';               // my-shell，绿灯、已打开、当前选中

/** 受控 input 要用原生 setter 赋值，React 覆盖了实例上的 value setter。 */
function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

/** 底部面板里的一项：按钮文字里同时有标签和提示，用 includes 匹配。 */
function sheetItem(text) {
  const el = buttons().find(b => b.textContent.includes(text));
  if (!el) throw new Error(`面板里找不到「${text}」`);
  return el;
}

const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  localStorage.clear();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('机器选择', () => {
  test('每台在线开发机一个胶囊，带会话数', () => {
    render();
    expect(byText('macmini2')).toBeTruthy();       // 名字 + 数量在同一个按钮里
    expect(byText('gpuserver11')).toBeTruthy();
  });

  test('点另一台机器会切过去', () => {
    render();
    click(byText('gpuserver11'));
    expect(calls).toEqual([['machine', 'gpuserver1']]);
  });

  test('一台机器都没在线时说清楚，而不是空白一片', () => {
    render({ machines: [], sessions: [] });
    expect(host.textContent).toContain('没有在线的开发机');
  });
});

describe('红绿灯', () => {
  test('isRunning=true 是红灯，false 是绿灯（hook 驱动，与桌面版同一个字段）', () => {
    render();
    const running = row(RUNNING_ROW).querySelector('span[title="运行中"]');
    const idle = row(IDLE_ROW).querySelector('span[title="空闲"]');
    expect(running).toBeTruthy();
    expect(idle).toBeTruthy();
    expect(running.style.background).toBe(rgb(DARK.danger));
    expect(idle.style.background).toBe(rgb(DARK.success));
  });
});

describe('打开 / 关闭 / 停止', () => {
  test('点一行会话就打开它，并带上启动命令与 cwd', () => {
    render();
    click(row(RUNNING_ROW));
    // cc- 前缀的自动会话标题取 cwd 末段
    expect(calls).toEqual([['open', 'macmini', 'cc-abc', ['claude', '--resume', 'cc-abc'], '/Users/gsj/VibeAnything']]);
  });

  test('✕ 只对已打开的会话出现，且只关标签不打开会话', () => {
    render();
    expect(row(RUNNING_ROW).querySelector('button[aria-label="关闭标签"]')).toBeNull();
    const close = row(IDLE_ROW).querySelector('button[aria-label="关闭标签"]');
    expect(close).toBeTruthy();
    click(close);
    expect(calls).toEqual([['close', 'macmini', 'my-shell']]);   // 没有多出一条 open
  });

  test('停止会话藏在 ⋯ 面板里，两步才点得到（行尾不放一碰就杀进程的按钮）', () => {
    render();
    // 行上没有直接的停止按钮
    expect(row(RUNNING_ROW).querySelector('button[aria-label="停止会话"]')).toBeNull();
    click(row(RUNNING_ROW).querySelector('button[aria-label="会话操作"]'));
    expect(calls).toEqual([]);                      // 开面板不该顺带把会话打开
    click(sheetItem('停止会话'));
    expect(calls).toEqual([['stop', 'macmini', 'cc-abc']]);
  });

  test('重命名藏在 ⋯ 面板里：预填当前显示名，确认后带上原 sessionId 与新名', () => {
    render();
    click(row(IDLE_ROW).querySelector('button[aria-label="会话操作"]'));
    click(sheetItem('重命名'));
    const input = host.querySelector('input');
    expect(input.value).toBe('my-shell');            // 用户自己起的 tmux 名，标题即原名
    type(input, 'my-dev');
    click(sheetItem('确定'));
    expect(calls).toEqual([['renameSession', 'macmini', 'my-shell', 'my-dev']]);
  });

  test('自动会话（cc-）重命名时预填的是 cwd 末段，不是没法读的 cc-abc', () => {
    render();
    click(row(RUNNING_ROW).querySelector('button[aria-label="会话操作"]'));
    click(sheetItem('重命名'));
    expect(host.querySelector('input').value).toBe('VibeAnything');
  });

  test('当前会话高亮，其它的不高亮', () => {
    render();
    expect(row(IDLE_ROW).style.borderLeft).toContain(rgb(DARK.accent));
    expect(row(RUNNING_ROW).style.borderLeft).toContain('transparent');
  });
});

describe('新建会话', () => {
  test('默认收起，点「＋ 新建」才展开', () => {
    render();
    expect(host.textContent).not.toContain('工作目录');
    click(byText('＋ 新建'));
    expect(host.textContent).toContain('工作目录');
  });

  test('目录预填这台机器的默认工作目录', () => {
    render();
    click(byText('＋ 新建'));
    const dir = host.querySelector('input[placeholder="/home/you/project"]');
    expect(dir.value).toBe('/Users/gsj');
  });

  test('已有会话的 cwd 作为快捷选项，点一下就填进去', () => {
    render();
    click(byText('＋ 新建'));
    const chip = byText('/Users/gsj/tmp');
    expect(chip).toBeTruthy();
    click(chip);
    expect(host.querySelector('input[placeholder="/home/you/project"]').value).toBe('/Users/gsj/tmp');
  });

  test('选 CLI + 填目录 → 带着机器/目录/命令创建，并收起面板', () => {
    render();
    click(byText('＋ 新建'));
    click(byText('bash'));
    type(host.querySelector('input[placeholder="/home/you/project"]'), '/srv/app');
    click(byText('在这里启动'));
    expect(calls).toEqual([['create', 'macmini', '/srv/app', ['bash']]]);
    expect(host.textContent).not.toContain('工作目录');
  });

  test('目录为空时不让创建 —— 开在哪儿都不知道', () => {
    render({ machines: [{ machineId: 'macmini', defaultWorkDir: '', sessionCount: 0 }], sessions: [] });
    click(byText('＋ 新建'));
    const go = byText('在这里启动');
    expect(go.disabled).toBe(true);
    click(go);
    expect(calls).toEqual([]);
  });
});

describe('空列表', () => {
  test('没有会话时给的是下一步动作，不是一片空白', () => {
    render({ sessions: [], openSessionIds: new Set(), activeSessionId: null });
    expect(host.textContent).toContain('没有运行中的会话');
    expect(host.textContent).toContain('＋ 新建');
  });
});

// ── 文件夹分组（2026-09-22 新增）────────────────────────────────
//
// 手机上没有右键也不能拖拽（拖拽 sensor 会和列表滚动抢手势），所有文件夹操作都走
// 「⋯ → 底部面板」。这里断言的就是那条唯一通路：点下去到底调了什么、带了什么参数。

const FOLDERS = [
  { id: 'f-work', name: '工作', parentId: null },
  { id: 'f-sub', name: '子项目', parentId: 'f-work' },
  { id: 'f-misc', name: '杂项', parentId: null },
];

// cc-abc 放进子文件夹，my-shell 留在根目录
const FOLDERED_SESSIONS = [
  { ...SESSIONS[0], folderId: 'f-sub' },
  { ...SESSIONS[1], folderId: null },
];

function renderWithFolders(overrides = {}) {
  render({
    folders: FOLDERS,
    sessions: FOLDERED_SESSIONS,
    onMoveSession: (...a) => calls.push(['moveSession', ...a]),
    onCreateFolder: (...a) => calls.push(['createFolder', ...a]),
    onRenameFolder: (...a) => calls.push(['renameFolder', ...a]),
    onDeleteFolder: (...a) => calls.push(['deleteFolder', ...a]),
    onMoveFolder: (...a) => calls.push(['moveFolder', ...a]),
    ...overrides,
  });
}

/** 文件夹行：用 aria-label 定位，避免和会话行混淆。 */
const folderRow = (name) => {
  const el = host.querySelector(`div[aria-label="文件夹 ${name}"]`);
  if (!el) throw new Error(`找不到文件夹行「${name}」`);
  return el;
};
const folderMenu = (name) => folderRow(name).querySelector(`button[aria-label="文件夹操作 ${name}"]`);
const hasRow = (cwd) => Array.from(host.querySelectorAll('div')).some(
  d => d.style.borderLeft && d.textContent.includes(cwd)
);

describe('文件夹分组', () => {
  test('按树渲染：子文件夹缩进在父级下，会话落在所属文件夹里', () => {
    renderWithFolders();
    expect(folderRow('工作')).toBeTruthy();
    expect(folderRow('子项目')).toBeTruthy();
    // 子文件夹的缩进要比父级深
    const pad = (el) => parseInt(el.style.paddingLeft, 10);
    expect(pad(folderRow('子项目'))).toBeGreaterThan(pad(folderRow('工作')));
    // 未分组的会话仍在列表里（不会因为有了文件夹就消失）
    expect(hasRow(IDLE_ROW)).toBe(true);
  });

  test('点文件夹行折叠，里面的会话真的从列表里消失（不是只藏起来）', () => {
    renderWithFolders();
    expect(hasRow(RUNNING_ROW)).toBe(true);
    click(folderRow('工作'));                 // 折叠父级，连子树一起收
    expect(hasRow(RUNNING_ROW)).toBe(false);
    expect(host.querySelector('div[aria-label="文件夹 子项目"]')).toBeNull();
    click(folderRow('工作'));                 // 再点展开
    expect(hasRow(RUNNING_ROW)).toBe(true);
  });

  test('折叠后仍显示会话数，里面有在跑的会话就亮红点', () => {
    renderWithFolders();
    click(folderRow('工作'));
    // 「工作」子树里只有 cc-abc 一个会话，且 isRunning=true
    expect(folderRow('工作').textContent).toContain('1');
    const dot = Array.from(folderRow('工作').querySelectorAll('span'))
      .find(el => el.style.borderRadius === '50%');
    expect(dot).toBeTruthy();
  });

  test('空文件夹给出怎么放东西进去的提示，而不是一片空白', () => {
    renderWithFolders();
    expect(host.textContent).toContain('空文件夹');
  });

  test('会话 ⋯ → 移动到文件夹 → 选目标，带对 machineId/sessionId/folderId', () => {
    renderWithFolders();
    click(row(RUNNING_ROW).querySelector('button[aria-label="会话操作"]'));
    click(sheetItem('移动到文件夹'));
    click(sheetItem('杂项'));
    expect(calls).toEqual([['moveSession', 'macmini', 'cc-abc', 'f-misc']]);
  });

  test('移到根目录传 null，不是空串（服务端按 null 判「不分组」）', () => {
    renderWithFolders();
    click(row(RUNNING_ROW).querySelector('button[aria-label="会话操作"]'));
    click(sheetItem('移动到文件夹'));
    click(sheetItem('根目录'));
    expect(calls).toEqual([['moveSession', 'macmini', 'cc-abc', null]]);
  });

  test('移动文件夹时排掉自己和自己的子树，否则树会成环', () => {
    renderWithFolders();
    click(folderMenu('工作'));
    click(sheetItem('移动到…'));
    // 目标里不能出现「工作」自己，也不能出现它的子孙「子项目」
    const labels = buttons().map(b => b.textContent);
    expect(labels.some(t => t.includes('杂项'))).toBe(true);
    expect(labels.some(t => t === '工作')).toBe(false);
    expect(labels.some(t => t === '子项目')).toBe(false);
  });

  test('＋ 文件夹 → 输入名字 → 建在根目录', () => {
    renderWithFolders();
    click(byText('＋ 文件夹'));
    type(host.querySelector('input'), '新分组');
    click(sheetItem('创建'));
    expect(calls).toEqual([['createFolder', 'macmini', '新分组', null]]);
  });

  test('在文件夹里新建子文件夹时带上 parentId', () => {
    renderWithFolders();
    click(folderMenu('工作'));
    click(sheetItem('在里面新建子文件夹'));
    type(host.querySelector('input'), '子分组');
    click(sheetItem('创建'));
    expect(calls).toEqual([['createFolder', 'macmini', '子分组', 'f-work']]);
  });

  test('重命名预填原名，确认后带上新名字', () => {
    renderWithFolders();
    click(folderMenu('杂项'));
    click(sheetItem('重命名'));
    expect(host.querySelector('input').value).toBe('杂项');
    type(host.querySelector('input'), '归档');
    click(sheetItem('确定'));
    expect(calls).toEqual([['renameFolder', 'macmini', 'f-misc', '归档']]);
  });

  test('删除要先确认；用户点取消就什么都不发', () => {
    const real = window.confirm;
    try {
      window.confirm = () => false;
      renderWithFolders();
      click(folderMenu('杂项'));
      click(sheetItem('删除文件夹'));
      expect(calls).toEqual([]);

      window.confirm = () => true;
      click(folderMenu('杂项'));
      click(sheetItem('删除文件夹'));
      expect(calls).toEqual([['deleteFolder', 'macmini', 'f-misc']]);
    } finally {
      window.confirm = real;
    }
  });

  test('操作失败时行内提示，点一下能关掉', () => {
    const cleared = [];
    renderWithFolders({ actionError: '没有权限', onClearActionError: () => cleared.push(1) });
    expect(host.textContent).toContain('没有权限');
    const banner = Array.from(host.querySelectorAll('div')).find(d => d.textContent.startsWith('没有权限'));
    click(banner);
    expect(cleared).toEqual([1]);
  });

  test('没有任何文件夹时就是原来的平铺列表，不多出空壳', () => {
    render();                                  // 不传 folders
    expect(host.querySelector('div[aria-label^="文件夹 "]')).toBeNull();
    expect(hasRow(RUNNING_ROW)).toBe(true);
    expect(hasRow(IDLE_ROW)).toBe(true);
  });
});
