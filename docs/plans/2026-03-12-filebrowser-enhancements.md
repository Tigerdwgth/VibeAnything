# FileBrowser 三项增强 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** FileBrowser 三项改进：目录树可切换根目录（默认非根路径）、文件可用 vim 打开、LaunchMenu 支持 bash/zsh。

**Architecture:** 所有改动集中在 `FileBrowser.jsx` 和 `SessionTabs.jsx` 两个前端文件，不涉及后端。`FileBrowser` 增加可编辑的根路径状态；文件行增加 vim 按钮；`CLI_CMDS` 和 `TOOL_STYLE` 加 bash/zsh 条目。改完后重新构建前端。

**Tech Stack:** React (函数组件 + hooks)、Vite 构建

---

### Task 1: 目录树默认根路径改为 Home，并支持路径导航

**Files:**
- Modify: `packages/server/frontend/src/FileBrowser.jsx`

当前问题：`DirTree` 始终从 `rootPath="/"` 渲染，展开整棵系统目录树太重。

**目标效果：**
- 初始根路径默认为最近目录中的第一个，若没有则为 `/` （前端无法直接拿到 HOME，用 `/` 兜底）
- 目录树上方显示当前根路径（可编辑输入框），支持：
  - 直接输入路径 → 按 Enter 跳转
  - 点击"↑"按钮 → 上一级目录

**Step 1: 在 `FileBrowser` 组件中增加 `treeRoot` state**

打开 `packages/server/frontend/src/FileBrowser.jsx`，在 `FileBrowser` 函数体顶部（`manualPath` state 下方）加：

```jsx
// 目录树根路径：默认用最近目录的第一个，否则用 /
const defaultRoot = [...new Set((historySessions || [])
  .filter(s => !selectedMachineId || s.machineId === selectedMachineId)
  .map(s => s.cwd).filter(Boolean))][0] || '/';
const [treeRoot, setTreeRoot] = useState(defaultRoot);
const [treeRootInput, setTreeRootInput] = useState(defaultRoot);
```

注意：这里 `defaultRoot` 在每次渲染时重新计算，但 `useState` 只取初始值，所以不会自动跟随 historySessions 更新（符合预期：用户主动导航才改变根路径）。

**Step 2: 替换"目录树"区块，增加路径导航栏**

找到：
```jsx
{/* 目录树 */}
<div style={{ borderTop: `1px solid ${T.border}`, paddingTop: '0.5rem', marginBottom: '0.5rem' }}>
  <div style={{ color: T.textMuted, fontSize: '0.65rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: '0.35rem' }}>目录树</div>
  <DirTree ws={ws} machineId={effectiveMachineId} rootPath="/" onLaunch={launchWithMachine} onPreviewMd={onPreviewMd} />
</div>
```

替换为：
```jsx
{/* 目录树 */}
<div style={{ borderTop: `1px solid ${T.border}`, paddingTop: '0.5rem', marginBottom: '0.5rem' }}>
  {/* 路径导航栏 */}
  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '0.35rem' }}>
    <button
      title="上一级目录"
      onClick={() => {
        const parent = treeRoot.replace(/\/[^/]+\/?$/, '') || '/';
        setTreeRoot(parent);
        setTreeRootInput(parent);
      }}
      style={{
        background: 'none', border: `1px solid ${T.border}`,
        color: T.textMuted, borderRadius: '4px',
        cursor: 'pointer', padding: '1px 5px', fontSize: '0.7rem', flexShrink: 0,
      }}
    >↑</button>
    <input
      className="path-input"
      value={treeRootInput}
      onChange={e => setTreeRootInput(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter' && treeRootInput.trim()) {
          setTreeRoot(treeRootInput.trim());
        }
      }}
      style={{
        flex: 1, background: T.bgInput, border: `1px solid ${T.border}`,
        color: T.textPrimary, borderRadius: T.radiusSm,
        padding: '2px 6px', fontSize: '0.72rem', outline: 'none',
        fontFamily: T.fontMono, transition: 'border-color 0.15s',
      }}
    />
  </div>
  <DirTree
    ws={ws}
    machineId={effectiveMachineId}
    rootPath={treeRoot}
    onLaunch={launchWithMachine}
    onPreviewMd={onPreviewMd}
    onNavigate={(path) => { setTreeRoot(path); setTreeRootInput(path); }}
  />
</div>
```

**Step 3: 在 `DirTree` 组件中接受 `onNavigate` prop，目录名可双击导航**

找到 `DirTree` 函数签名：
```jsx
function DirTree({ ws, machineId, rootPath, onLaunch, onPreviewMd }) {
```
改为：
```jsx
function DirTree({ ws, machineId, rootPath, onLaunch, onPreviewMd, onNavigate }) {
```

找到目录名的 `<span>` onClick（第一个目录 onClick，展开用的那个）：
```jsx
<span
  style={{ flex: 1, color: T.textSecondary, fontSize: '0.75rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
  onClick={() => setExpanded(p => ({ ...p, [entry.path]: !p[entry.path] }))}
>
  {entry.name}
</span>
```
替换为（增加 `onDoubleClick` 导航，保留单击展开）：
```jsx
<span
  style={{ flex: 1, color: T.textSecondary, fontSize: '0.75rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
  onClick={() => setExpanded(p => ({ ...p, [entry.path]: !p[entry.path] }))}
  onDoubleClick={() => onNavigate?.(entry.path)}
  title={`单击展开，双击设为根目录`}
>
  {entry.name}
</span>
```

**Step 4: 构建并验证**

```bash
cd /home/user/claude-code-hooks-feishu/packages/server/frontend && npm run build
```

Expected: 构建成功，无 TypeScript/JSX 报错。

打开 Dashboard → 目录 Tab，验证：
- 默认根路径是最近目录（非 `/`）
- 输入路径 Enter 可跳转
- ↑ 按钮可上一级
- 双击目录名可设为根路径

**Step 5: Commit**

```bash
cd /home/user/claude-code-hooks-feishu
git add packages/server/frontend/src/FileBrowser.jsx packages/server/frontend/dist/
git commit -m "feat(filebrowser): 目录树支持自定义根路径，默认为最近目录"
```

---

### Task 2: 文件支持用 vim 打开

**Files:**
- Modify: `packages/server/frontend/src/FileBrowser.jsx`

**目标效果：**
- 目录树中所有文件（不限于 .md）显示一个小"vim"按钮（hover 时出现）
- 点击 vim 按钮：以 `['vim', filePath]` 为 command、文件所在目录为 cwd 启动新 terminal

**Step 1: 给文件行加 vim 按钮**

在 `DirTree` 组件的文件行（`entry.type !== 'dir'` 分支），找到：
```jsx
) : (
  <>
    <span style={{ width: '10px', flexShrink: 0 }} />
    <span style={{ fontSize: '0.72rem' }}>{isMd(entry.name) ? '📄' : '📃'}</span>
    <span
      style={{
        flex: 1, fontSize: '0.75rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        color: isMd(entry.name) ? T.accent : T.textMuted,
        cursor: isMd(entry.name) ? 'pointer' : 'default',
      }}
      onClick={() => isMd(entry.name) && onPreviewMd?.(entry.path)}
    >
      {entry.name}
    </span>
  </>
)}
```

替换为：
```jsx
) : (
  <>
    <span style={{ width: '10px', flexShrink: 0 }} />
    <span style={{ fontSize: '0.72rem' }}>{isMd(entry.name) ? '📄' : '📃'}</span>
    <span
      style={{
        flex: 1, fontSize: '0.75rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        color: isMd(entry.name) ? T.accent : T.textMuted,
        cursor: isMd(entry.name) ? 'pointer' : 'default',
      }}
      onClick={() => isMd(entry.name) && onPreviewMd?.(entry.path)}
    >
      {entry.name}
    </span>
    {/* vim 按钮：点击在新 terminal 中用 vim 打开该文件 */}
    <button
      className="dir-launch"
      title={`用 vim 打开 ${entry.path}`}
      onClick={e => {
        e.stopPropagation();
        const dir = entry.path.replace(/\/[^/]+$/, '') || '/';
        onLaunch(dir, ['vim', entry.path]);
      }}
      style={{
        background: 'none', border: `1px solid ${T.border}`,
        color: T.textMuted, borderRadius: '4px',
        cursor: 'pointer', padding: '1px 5px', fontSize: '0.62rem',
        flexShrink: 0, transition: 'all 0.12s', opacity: 0,
      }}
      onMouseEnter={e => { e.currentTarget.style.opacity = '1'; }}
      onMouseLeave={e => { e.currentTarget.style.opacity = '0'; }}
    >vim</button>
  </>
)}
```

注意：`dir-launch:hover` 的 CSS 在第 99 行已有定义，vim 按钮共用此 class。

**Step 2: 构建并验证**

```bash
cd /home/user/claude-code-hooks-feishu/packages/server/frontend && npm run build
```

验证：
- 鼠标悬停到文件行，右侧出现"vim"按钮
- 点击后在"已打开"Tab 看到新 terminal，标签为 vim 对应的 sessionId
- 在 terminal 中 vim 正常打开该文件

**Step 3: Commit**

```bash
cd /home/user/claude-code-hooks-feishu
git add packages/server/frontend/src/FileBrowser.jsx packages/server/frontend/dist/
git commit -m "feat(filebrowser): 文件支持 vim 打开"
```

---

### Task 3: LaunchMenu 和运行中列表支持 bash/zsh

**Files:**
- Modify: `packages/server/frontend/src/FileBrowser.jsx`
- Modify: `packages/server/frontend/src/SessionTabs.jsx`

**目标效果：**
- 目录的 ▶ 启动菜单中出现 bash 和 zsh 选项
- "已打开"Tab 的 tool badge 显示 bash/zsh 标签（带合适颜色）

**Step 1: 在 `FileBrowser.jsx` 的 `CLI_CMDS` 加 bash/zsh**

找到文件顶部：
```js
const CLI_CMDS = [
  { label: 'claude', cmd: ['claude'] },
  { label: 'codex',  cmd: ['codex'] },
  { label: 'gemini', cmd: ['gemini'] },
];
```
替换为：
```js
const CLI_CMDS = [
  { label: 'claude', cmd: ['claude'] },
  { label: 'codex',  cmd: ['codex'] },
  { label: 'gemini', cmd: ['gemini'] },
  { label: 'bash',   cmd: ['bash'] },
  { label: 'zsh',    cmd: ['zsh'] },
];
```

**Step 2: 在 `SessionTabs.jsx` 的 `TOOL_STYLE` 加 bash/zsh 颜色**

找到：
```js
const TOOL_STYLE = {
  cc:     { bg: 'rgba(99,102,241,0.12)',  color: '#818cf8', border: 'rgba(99,102,241,0.25)' },
  codex:  { bg: 'rgba(249,115,22,0.12)', color: '#fb923c', border: 'rgba(249,115,22,0.25)' },
  gemini: { bg: 'rgba(139,92,246,0.12)', color: '#a78bfa', border: 'rgba(139,92,246,0.25)' },
};
```
替换为：
```js
const TOOL_STYLE = {
  cc:     { bg: 'rgba(99,102,241,0.12)',  color: '#818cf8', border: 'rgba(99,102,241,0.25)' },
  codex:  { bg: 'rgba(249,115,22,0.12)', color: '#fb923c', border: 'rgba(249,115,22,0.25)' },
  gemini: { bg: 'rgba(139,92,246,0.12)', color: '#a78bfa', border: 'rgba(139,92,246,0.25)' },
  bash:   { bg: 'rgba(34,197,94,0.12)',  color: '#4ade80', border: 'rgba(34,197,94,0.25)' },
  zsh:    { bg: 'rgba(20,184,166,0.12)', color: '#2dd4bf', border: 'rgba(20,184,166,0.25)' },
};
```

**Step 3: 更新 `toolName` 函数以识别 bash/zsh**

找到 `toolName` 函数（SessionTabs.jsx）：
```js
function toolName(command) {
  if (!command || !command.length) return 'cc';
  const bin = command[0];
  if (bin === 'claude') return 'cc';
  return bin; // codex, gemini, etc.
}
```

这里已经通过 `return bin` 自动返回 `bash` / `zsh`，无需修改。

**Step 4: 构建并验证**

```bash
cd /home/user/claude-code-hooks-feishu/packages/server/frontend && npm run build
```

验证：
- 目录树 ▶ 菜单出现 bash 和 zsh 按钮
- 点击 bash/zsh 启动后，"已打开"Tab 显示绿色/青色 bash/zsh badge
- bash/zsh 终端可正常交互（不是 Claude，是真实 shell）

**Step 5: Commit**

```bash
cd /home/user/claude-code-hooks-feishu
git add packages/server/frontend/src/FileBrowser.jsx packages/server/frontend/src/SessionTabs.jsx packages/server/frontend/dist/
git commit -m "feat(filebrowser): LaunchMenu 支持 bash/zsh 启动"
```

---

## 注意事项

- Task 1 中 `treeRootInput` 和 `treeRoot` 分离是因为：输入框需要实时反映用户打字，但根路径只在按 Enter 时更新，避免每次输入字符都重新发 `list_dir` 请求。
- vim 按钮用 hover 显示/隐藏（inline style opacity），不影响目录行布局。
- bash/zsh 在 `pty-manager.js` 的 `create()` 中走的是通用命令路径，只有 `cmd === 'claude'` 时才加 `--dangerously-skip-permissions`，bash/zsh 不受影响。
- 每个 Task 独立构建验证，便于逐步回滚。
