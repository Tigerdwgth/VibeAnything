import { useState, useRef, useEffect, useId } from 'react';
import { DndContext, useDraggable, useDroppable, MouseSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core';
import { useTheme } from './theme';
import FileBrowser from './FileBrowser';
import { DEFAULT_LAUNCH_COMMAND } from './launch-config';
import { buildSessionTree, flattenFolderPaths, isDescendant } from './folder-tree';
import useFolderCollapse from './useFolderCollapse';
import ContextMenu from './ContextMenu';
import SessionSharing from './SessionSharing';
import { MOUSE_DRAG_ACTIVATION, TOUCH_DRAG_ACTIVATION, DRAGGABLE_TOUCH_ACTION } from './dnd-activation';
import {
  getRunningSessionCommand,
  getRunningSessionDetail,
  getRunningSessionTitle,
  stripSessionPrefix,
} from './session-list-utils';
// 机器名显示用短名、完整名放 title（共用模块，开发机面板/机器下拉同一份）
import { shortMachineId } from './machine-name';

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const itemStyle = (T, selected) => ({
  padding: '0.35rem 0.6rem',
  cursor: 'pointer',
  borderRadius: T.radiusSm,
  fontSize: '0.78rem',
  background: selected ? T.accentDim : 'transparent',
  color: selected ? T.accent : T.textSecondary,
  borderLeft: `2px solid ${selected ? T.accent : 'transparent'}`,
  transition: 'all 0.12s',
  display: 'flex', alignItems: 'center', gap: '6px',
});

// 去除 sessionId 中的工具前缀（cc-、codex- 等）
// （终端类型徽章已移除：它常与真实打开的进程不符，且行内已有红绿灯状态点）

// ── 会话 Tab：多级文件夹分组 + 重命名 + 拖拽 ────────────────

// inline 文本编辑（重命名会话/文件夹共用）
function EditableText({ value, onSubmit, onCancel, T }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) { ref.current.focus(); ref.current.select(); } }, []);
  return (
    <input
      ref={ref}
      defaultValue={value}
      onClick={e => e.stopPropagation()}
      onMouseDown={e => e.stopPropagation()}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); onSubmit(e.currentTarget.value); }
        else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      }}
      onBlur={e => onSubmit(e.currentTarget.value)}
      style={{
        flex: 1, minWidth: 0, fontSize: '0.78rem',
        background: T.bgBase, color: T.textPrimary,
        border: `1px solid ${T.accent}`, borderRadius: '4px',
        padding: '1px 4px', fontFamily: T.fontSans,
      }}
    />
  );
}

// 单个运行中会话项（可拖拽、右键菜单、inline 重命名），复用原两行 DOM 结构
// isOpened：该会话是否已在浏览器中打开（sessionId 在 openTerminals 里）
// onClose：关闭已打开的 Tab（只关 tab 不杀进程），仅对已打开会话显示 ✕
function SessionItem({ session, machineId, depth, active, isOpened, onOpen, onStop, onClose, openMenu, editing, onRename, onCancelEdit, T }) {
  const drag = useDraggable({ id: `s:${machineId}:${session.sessionId}`, data: { kind: 'session', machineId, id: session.sessionId } });
  const selected = active?.sessionId === session.sessionId && active?.machineId === machineId;
  return (
    <div
      ref={drag.setNodeRef}
      {...drag.listeners}
      {...drag.attributes}
      className="sess-item"
      onClick={() => { if (!editing) onOpen(machineId, session.sessionId, getRunningSessionCommand(session), session.cwd); }}
      onContextMenu={(e) => { e.preventDefault(); openMenu(e, { type: 'session', session }); }}
      style={{
        ...itemStyle(T, selected),
        // 已打开但未选中时给一个微亮底色，强调“已打开”状态
        ...(isOpened && !selected ? { background: T.accentDim } : {}),
        flexDirection: 'column', alignItems: 'stretch', gap: '2px',
        padding: '0.4rem 0.6rem', paddingLeft: `${0.6 + depth * 0.85}rem`,
        opacity: drag.isDragging ? 0.4 : 1,
        touchAction: DRAGGABLE_TOUCH_ACTION,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
        {/* 已打开标记：左侧高亮小圆点 */}
        {isOpened && (
          <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: T.accent, flexShrink: 0 }} />
        )}
        {/* 红绿灯会话状态点：完全由 Claude Code hook 驱动。每个会话都有灯——
              isRunning === true  → 🔴红灯（正在运行：hook UserPromptSubmit）
              isRunning === false → 🟢绿灯（空闲：hook Stop / 没装 hook / 没在跑）
            不再有 PTY 输出活跃度兜底，所以「点开会话 attach 重绘」不会再让它变红。 */}
        <span
          title={session.isRunning ? '运行中' : '空闲'}
          style={{
            width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0,
            background: session.isRunning ? T.danger : T.success,
            boxShadow: `0 0 4px ${session.isRunning ? T.danger : T.success}`,
          }}
        />
        {editing ? (
          <EditableText value={getRunningSessionTitle(session)} onSubmit={onRename} onCancel={onCancelEdit} T={T} />
        ) : (
          <span style={{ color: T.textPrimary, fontSize: '0.78rem', fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {getRunningSessionTitle(session)}
          </span>
        )}
        {session._optimistic && (
          <span style={{ color: T.warning, fontSize: '0.62rem', animation: 'pulse 1.5s infinite', flexShrink: 0 }}>恢复中…</span>
        )}
        {session.sharedBy && <span title={`由 ${session.sharedBy} 共享`} style={{ color: T.accent, fontSize: '0.62rem' }}>共享</span>}
        {/* 归属徽章：后端仅对 admin 下发 owner 字段。
            owner 为 null = 无主会话（仅 admin 可见），标成「无主」提示需要转交。 */}
        {'owner' in session && (
          <span
            title={session.owner ? `归属：${session.owner}` : '无主会话：仅管理员可见，建议转交给使用者'}
            style={{
              color: session.owner ? T.textMuted : T.warning,
              border: `1px solid ${session.owner ? T.border : T.warning}`,
              borderRadius: '3px', padding: '0 3px',
              fontSize: '0.6rem', flexShrink: 0, whiteSpace: 'nowrap',
            }}>{session.owner || '无主'}</span>
        )}
        <span style={{ color: T.textMuted, fontSize: '0.65rem', flexShrink: 0 }}>{timeAgo(session.mtime)}</span>
        {/* ✕ 仅对已打开会话显示：只关闭 Tab，不杀进程 */}
        {isOpened && onClose && (
          <button
            onClick={e => { e.stopPropagation(); onClose(machineId, session.sessionId); }}
            onMouseDown={e => e.stopPropagation()}
            title="关闭此 Tab（不杀进程）"
            style={{ background: 'none', border: 'none', color: T.textMuted, cursor: 'pointer', padding: '0 3px', fontSize: '0.7rem', flexShrink: 0 }}>✕</button>
        )}
        {/* ■ 停止此 session：真正杀进程 */}
        {onStop && (
          <button
            onClick={e => { e.stopPropagation(); onStop(machineId, session.sessionId); }}
            onMouseDown={e => e.stopPropagation()}
            title="停止此 session"
            style={{ background: 'none', border: 'none', color: T.danger, cursor: 'pointer', padding: '0 3px', fontSize: '0.7rem', flexShrink: 0 }}>■</button>
        )}
      </div>
      <div
        title={getRunningSessionDetail(session)}
        style={{ color: T.textMuted, fontSize: '0.68rem', fontFamily: T.fontMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {getRunningSessionDetail(session) || stripSessionPrefix(session.sessionId)}
      </div>
    </div>
  );
}

// 递归文件夹节点：可拖拽（改父级）、可作为放置目标、折叠/展开、右键菜单、inline 重命名
// openSessionIds：已打开会话的 sessionId 集合（Set），用于标记“已打开”状态并透传给 SessionItem
function FolderNode({ node, machineId, depth, active, openSessionIds, collapse, callbacks, openMenu, editingKey, setEditingKey, T }) {
  const drop = useDroppable({ id: `drop-f:${machineId}:${node.id}`, data: { machineId, folderId: node.id } });
  const drag = useDraggable({ id: `f:${machineId}:${node.id}`, data: { kind: 'folder', machineId, id: node.id } });
  const collapsed = collapse.isCollapsed(node.id);
  const editing = editingKey === `folder:${node.id}`;
  const count = node.sessions.length + node.children.length;

  return (
    <div ref={drop.setNodeRef} style={{ background: drop.isOver ? T.accentDim : 'transparent', borderRadius: T.radiusSm }}>
      <div
        ref={drag.setNodeRef}
        {...drag.listeners}
        {...drag.attributes}
        onClick={() => { if (!editing) collapse.toggle(node.id); }}
        onContextMenu={(e) => { e.preventDefault(); openMenu(e, { type: 'folder', node }); }}
        style={{
          display: 'flex', alignItems: 'center', gap: '4px',
          padding: '0.3rem 0.6rem', paddingLeft: `${0.6 + depth * 0.85}rem`,
          cursor: 'pointer', fontSize: '0.76rem', color: T.textSecondary,
          opacity: drag.isDragging ? 0.4 : 1,
          touchAction: DRAGGABLE_TOUCH_ACTION,
        }}
      >
        <span style={{ width: 12, flexShrink: 0, color: T.textMuted, fontSize: '0.7rem' }}>{collapsed ? '▸' : '▾'}</span>
        <span style={{ flexShrink: 0 }}>📁</span>
        {editing ? (
          <EditableText
            value={node.name}
            onSubmit={(v) => { callbacks.onRenameFolder(machineId, node.id, v); setEditingKey(null); }}
            onCancel={() => setEditingKey(null)}
            T={T}
          />
        ) : (
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{node.name}</span>
        )}
        {count > 0 && <span style={{ color: T.textMuted, fontSize: '0.62rem', flexShrink: 0 }}>{count}</span>}
      </div>
      {!collapsed && (
        // 文件夹内容区：左侧加一条竖线 + 左缩进，让「属于这个文件夹的东西」一眼可见层级。
        // 竖线缩进随 depth 递进对齐文件夹图标，子文件夹/会话自身 depth=0（缩进由这层容器提供）。
        <div style={{
          marginLeft: `${1.1 + depth * 0.85}rem`,
          borderLeft: `1px solid ${T.border}`,
          paddingLeft: '0.2rem',
        }}>
          {node.children.map(child => (
            <FolderNode
              key={child.id} node={child} machineId={machineId} depth={0} active={active}
              openSessionIds={openSessionIds}
              collapse={collapse} callbacks={callbacks} openMenu={openMenu}
              editingKey={editingKey} setEditingKey={setEditingKey} T={T}
            />
          ))}
          {node.sessions.map(s => (
            <SessionItem
              key={s.sessionId} session={s} machineId={machineId} depth={0} active={active}
              isOpened={openSessionIds.has(s.sessionId)}
              onOpen={callbacks.onOpen} onStop={callbacks.onStop} onClose={callbacks.onClose} openMenu={openMenu}
              editing={editingKey === `sess:${s.sessionId}`}
              onRename={(v) => { callbacks.onRenameSession(machineId, s.sessionId, v); setEditingKey(null); }}
              onCancelEdit={() => setEditingKey(null)} T={T}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// 单台机器的运行中分组：文件夹树 + 根级会话 + 右键菜单
function MachineRunningGroup({ machineId, sessions, folders, active, openSessionIds, callbacks }) {
  const T = useTheme();
  const collapse = useFolderCollapse(machineId);
  const contentId = useId();
  const storageKey = `machineCollapsed:${machineId}`;
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(storageKey) === 'true'; } catch { return false; }
  });
  const changeCollapsed = (next) => {
    setCollapsed(next);
    setMenu(null);
    try { localStorage.setItem(storageKey, String(next)); } catch { /* 存储不可用仍可折叠 */ }
  };
  const runningCount = sessions.filter(s => s.isRunning).length;
  const containsActive = active?.machineId === machineId && sessions.some(s => s.sessionId === active.sessionId);
  const [menu, setMenu] = useState(null);          // { x, y, target }
  const [editingKey, setEditingKey] = useState(null); // 'sess:<id>' | 'folder:<id>'
  const { rootFolders, rootSessions } = buildSessionTree(folders, sessions);
  const rootDrop = useDroppable({ id: `drop-root:${machineId}`, data: { machineId, folderId: null }, disabled: collapsed });

  const openMenu = (e, target) => setMenu({ x: e.clientX, y: e.clientY, target });

  const menuItems = () => {
    if (!menu) return [];
    const { target } = menu;
    if (target.type === 'folder') {
      return [
        { label: '✎ 重命名', onClick: () => setEditingKey(`folder:${target.node.id}`) },
        { label: '＋ 新建子文件夹', onClick: () => callbacks.onCreateFolder(machineId, '新文件夹', target.node.id) },
        null,
        { label: '🗑 删除文件夹', danger: true, onClick: () => {
          if (confirm('删除该文件夹？里面的会话和子文件夹会移到上一级')) callbacks.onDeleteFolder(machineId, target.node.id);
        } },
      ];
    }
    const sid = target.session.sessionId;
    return [
      ...(target.session.canShare ? [{ label: '共享窗口…', onClick: () => callbacks.onShare({ ...target.session, machineId }) }] : []),
      { label: '✎ 重命名', onClick: () => setEditingKey(`sess:${sid}`) },
      null,
      { label: '↳ 移动到根目录', onClick: () => callbacks.onMoveSession(machineId, sid, null) },
      ...flattenFolderPaths(folders).map(f => ({
        label: `📁 ${f.label}`, onClick: () => callbacks.onMoveSession(machineId, sid, f.id),
      })),
    ];
  };

  return (
    <div style={{ marginBottom: '0.75rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' }}>
        <button
          type="button"
          className="machine-toggle"
          aria-label={`${collapsed ? '展开' : '收起'}开发机 ${machineId}`}
          aria-expanded={!collapsed}
          aria-controls={contentId}
          onClick={() => changeCollapsed(!collapsed)}
          title={machineId}
          style={{
            display: 'flex', alignItems: 'center', gap: '6px', flex: 1, minWidth: 0,
            minHeight: '34px', padding: '5px 6px', cursor: 'pointer', textAlign: 'left',
            background: containsActive ? T.accentDim : T.bgCard,
            border: `1px solid ${containsActive ? T.borderAccent : T.border}`,
            borderRadius: T.radiusSm, color: T.textSecondary, fontFamily: T.fontSans,
          }}
        >
          <span aria-hidden="true" style={{ flexShrink: 0, transform: collapsed ? 'none' : 'rotate(90deg)', transition: 'transform 0.12s' }}>▸</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.75rem', fontWeight: 600 }}>{shortMachineId(machineId)}</span>
          {containsActive && <span title="当前会话所在开发机" style={{ fontSize: '0.62rem', color: T.accent, flexShrink: 0 }}>当前</span>}
          <span style={{ fontSize: '0.65rem', color: T.textMuted, flexShrink: 0 }}>{sessions.length} 会话</span>
          {runningCount > 0 && <span style={{ fontSize: '0.62rem', color: T.danger, flexShrink: 0 }}>{runningCount} 运行中</span>}
        </button>
        <button
          type="button"
          className="folder-add-btn"
          onClick={() => { changeCollapsed(false); callbacks.onCreateFolder(machineId, '新文件夹', null); }}
          title="新建文件夹"
          aria-label={`在 ${machineId} 新建文件夹`}
          style={{ background: 'none', border: `1px solid ${T.border}`, color: T.textMuted, borderRadius: '4px', cursor: 'pointer', padding: '0 6px', minHeight: '34px', flexShrink: 0, fontSize: '0.68rem' }}
        >＋📁</button>
      </div>
      <div id={contentId} hidden={collapsed}>
        {!collapsed && <div ref={rootDrop.setNodeRef} style={{ background: rootDrop.isOver ? T.bgHover : 'transparent', borderRadius: T.radiusSm, paddingBottom: '2px', minHeight: '8px' }}>
          {rootFolders.map(node => (
            <FolderNode
              key={node.id} node={node} machineId={machineId} depth={0} active={active}
              openSessionIds={openSessionIds}
              collapse={collapse} callbacks={callbacks} openMenu={openMenu}
              editingKey={editingKey} setEditingKey={setEditingKey} T={T}
            />
          ))}
          {rootSessions.map(s => (
            <SessionItem
              key={s.sessionId} session={s} machineId={machineId} depth={0} active={active}
              isOpened={openSessionIds.has(s.sessionId)}
              onOpen={callbacks.onOpen} onStop={callbacks.onStop} onClose={callbacks.onClose} openMenu={openMenu}
              editing={editingKey === `sess:${s.sessionId}`}
              onRename={(v) => { callbacks.onRenameSession(machineId, s.sessionId, v); setEditingKey(null); }}
              onCancelEdit={() => setEditingKey(null)} T={T}
            />
          ))}
        </div>}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={() => setMenu(null)} />}
    </div>
  );
}

function RunningTab({ onShare, activeSessions, foldersByMachine, openTerminals = [], active, onOpen, onStop, onClose, onRenameSession, onMoveSession, onCreateFolder, onRenameFolder, onDeleteFolder, onMoveFolder }) {
  const T = useTheme();
  // 鼠标：移动 5px 即开拖（避免点击会话项 attach 终端被误判为拖拽）。
  // 触屏：长按 250ms 才开拖，之前划动超过 5px 取消拖拽还给
  // 浏览器滚动 —— 否则手机上整个会话列表都滑不动（见 dnd-activation.js）。
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: MOUSE_DRAG_ACTIVATION }),
    useSensor(TouchSensor, { activationConstraint: TOUCH_DRAG_ACTIVATION }),
  );
  // 已打开会话的 sessionId 集合：来自浏览器 openTerminals，用于在会话列表里标记“已打开”
  const openSessionIds = new Set(openTerminals.map(t => t.sessionId));
  const byMachine = activeSessions.reduce((acc, s) => {
    const mid = s.machineId || 'local';
    (acc[mid] = acc[mid] || []).push(s);
    return acc;
  }, {});

  const handleDragEnd = (event) => {
    const { active: a, over } = event;
    if (!over) return;
    const ad = a.data.current, od = over.data.current;
    if (!ad || !od || ad.machineId !== od.machineId) return; // 跨机器禁止移动
    const target = od.folderId; // null = 根
    if (ad.kind === 'session') {
      onMoveSession(ad.machineId, ad.id, target);
    } else if (ad.kind === 'folder') {
      if (ad.id === target) return;                           // 拖到自身
      const folders = foldersByMachine[ad.machineId] || [];
      if (target && isDescendant(folders, target, ad.id)) return; // 不能拖进自己的子树
      onMoveFolder(ad.machineId, ad.id, target);
    }
  };

  // onClose：关闭已打开 Tab（不杀进程），随 callbacks 一路透传到 SessionItem
  const callbacks = { onShare, onOpen, onStop, onClose, onRenameSession, onMoveSession, onCreateFolder, onRenameFolder, onDeleteFolder, onMoveFolder };

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '0.5rem' }}>
      <style>{`.machine-toggle:hover { border-color: ${T.accent} !important; } .machine-toggle:focus-visible { outline: 2px solid ${T.accent}; outline-offset: 2px; } .sess-item:hover { background: ${T.bgHover} !important; color: ${T.textPrimary} !important; }`}</style>
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        {Object.entries(byMachine).map(([machineId, sess]) => (
          <MachineRunningGroup
            key={machineId} machineId={machineId} sessions={sess}
            folders={foldersByMachine[machineId] || []} active={active}
            openSessionIds={openSessionIds} callbacks={callbacks}
          />
        ))}
      </DndContext>
      {activeSessions.length === 0 && <EmptyState text="无运行中 session" />}
    </div>
  );
}

// ── 历史 Tab ──────────────────────────────────────────────────
function HistoryTab({ historySessions, active, onOpen, onDelete }) {
  const T = useTheme();
  const [hovered, setHovered] = useState(null);
  // 选中的机器：只显示这台的历史，避免所有机器堆一起要往下翻。null = 还没选/默认第一台
  const [selectedMachine, setSelectedMachine] = useState(null);

  const byMachine = historySessions.reduce((acc, s) => {
    const mid = s.machineId || 'local';
    (acc[mid] = acc[mid] || []).push(s);
    return acc;
  }, {});

  const machineIds = Object.keys(byMachine);
  // 默认选第一台机器（机器列表变化时若当前选中的已不存在，回落到第一台）
  const curMachine = (selectedMachine && byMachine[selectedMachine]) ? selectedMachine : machineIds[0];

  const renderSession = (s) => (
    <div
      key={s.sessionId}
      className="hist-item"
      onMouseEnter={() => setHovered(s.sessionId)}
      onMouseLeave={() => setHovered(null)}
      style={{
        ...itemStyle(T, active?.sessionId === s.sessionId),
        flexDirection: 'column', alignItems: 'stretch', gap: '2px',
        padding: '0.4rem 0.6rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
        <span style={{ color: T.textPrimary, fontSize: '0.78rem', fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {s.cwd?.split('/').pop() || '/'}
        </span>
        {s.gitBranch && (
          <span style={{
            background: T.accentDim, color: T.accent,
            borderRadius: T.radiusPill, padding: '1px 6px',
            fontSize: '0.62rem', fontWeight: 500, flexShrink: 0,
          }}>{s.gitBranch}</span>
        )}
        <span style={{ color: T.textMuted, fontSize: '0.62rem', flexShrink: 0 }}>
          {s.timestamp?.slice(0, 10)}
        </span>
      </div>
      {s.summary ? (
        <div style={{ color: T.textMuted, fontSize: '0.68rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {s.summary}
        </div>
      ) : (
        <span style={{ background: T.bgHover, color: T.textMuted, borderRadius: T.radiusPill, padding: '1px 6px', fontSize: '0.6rem' }}>空会话</span>
      )}
      <div className="hist-actions" style={{ display: 'flex', gap: '4px', marginTop: '3px' }}>
        {(!s.tool || s.tool === 'claude') && <>
          <button
            className="hist-btn"
            title="在此目录启动 codex"
            onClick={e => { e.stopPropagation(); onOpen(s.machineId || 'local', s.sessionId, DEFAULT_LAUNCH_COMMAND, s.cwd); }}
            style={{
              background: T.bgCard, border: `1px solid ${T.border}`,
              color: T.success, borderRadius: '4px',
              cursor: 'pointer', padding: '1px 7px', fontSize: '0.7rem',
              fontFamily: T.fontSans, transition: 'background 0.12s',
            }}>▶ 新建</button>
          <button
            className="hist-btn"
            title={`claude --resume ${s.sessionId}`}
            onClick={e => { e.stopPropagation(); onOpen(s.machineId || 'local', s.sessionId, ['claude', '--resume', s.sessionId], s.cwd); }}
            style={{
              background: T.bgCard, border: `1px solid ${T.border}`,
              color: T.accent, borderRadius: '4px',
              cursor: 'pointer', padding: '1px 7px', fontSize: '0.7rem',
              fontFamily: T.fontSans, transition: 'background 0.12s',
            }}>↩ 恢复</button>
        </>}
        {onDelete && (
        <button
          className="hist-btn"
          title="删除此 session"
          onClick={e => { e.stopPropagation(); onDelete(s.machineId || 'local', s.sessionId); }}
          style={{
            background: T.bgCard, border: `1px solid ${T.border}`,
            color: T.danger, borderRadius: '4px',
            cursor: 'pointer', padding: '1px 7px', fontSize: '0.7rem',
            fontFamily: T.fontSans, transition: 'background 0.12s',
          }}>✕ 删除</button>
        )}
      </div>
    </div>
  );

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <style>{`
        .hist-item:hover { background: ${T.bgHover} !important; }
        .hist-actions { opacity: 0; transition: opacity 0.15s; }
        .hist-item:hover .hist-actions { opacity: 1 !important; }
        .hist-btn:hover { background: ${T.bgBase} !important; }
        .mach-chip:hover { border-color: ${T.accent} !important; }
      `}</style>
      {/* 机器选择器：一排芯片，选中某台才显示它的历史，不用往下翻 */}
      {machineIds.length > 1 && (
        <div style={{
          display: 'flex', gap: '4px', flexWrap: 'wrap',
          padding: '6px 8px', borderBottom: `1px solid ${T.border}`, flexShrink: 0,
        }}>
          {machineIds.map(mid => {
            const sel = mid === curMachine;
            return (
              <button
                key={mid}
                className="mach-chip"
                onClick={() => setSelectedMachine(mid)}
                title={mid}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '4px',
                  padding: '3px 9px', borderRadius: T.radiusPill,
                  background: sel ? T.accentDim : 'transparent',
                  border: `1px solid ${sel ? T.accent : T.border}`,
                  color: sel ? T.accent : T.textMuted,
                  cursor: 'pointer', fontSize: '0.68rem', fontWeight: sel ? 600 : 400,
                  fontFamily: T.fontSans, transition: 'all 0.12s',
                  maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
              >
                {shortMachineId(mid)}
                <span style={{
                  background: sel ? T.accent : 'rgba(128,128,128,0.18)',
                  color: sel ? T.bgBase : T.textMuted,
                  borderRadius: T.radiusPill, padding: '0 5px', fontSize: '0.58rem', fontWeight: 600,
                }}>{byMachine[mid].length}</span>
              </button>
            );
          })}
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0.5rem' }}>
        {curMachine && byMachine[curMachine]?.map(renderSession)}
        {historySessions.length === 0 && <EmptyState text="无历史 session" />}
      </div>
    </div>
  );
}

function EmptyState({ text }) {
  const T = useTheme();
  return (
    <div style={{ textAlign: 'center', padding: '1.5rem 0.5rem', color: T.textMuted, fontSize: '0.75rem' }}>
      {text}
    </div>
  );
}

// ── 主组件 ────────────────────────────────────────────────────
export default function SessionTabs({ token, sessions, activeSessions, foldersByMachine = {}, historySessions, openTerminals, active, onOpen, onClose, onDelete, onStop, onRenameSession, onMoveSession, onCreateFolder, onRenameFolder, onDeleteFolder, onMoveFolder, ws, machineId, machines, onLaunch, onPreviewMd, onSelectMachine }) {
  const T = useTheme();
  // 默认进「会话」Tab（原“运行中”，已合并“已打开”）
  const [tab, setTab] = useState('running');
  const [sharingSession, setSharingSession] = useState(null);

  const tabs = [
    { key: 'running', label: '会话', count: activeSessions.length },
    { key: 'history', label: '历史', count: historySessions.length },
    { key: 'files',   label: '目录' },
  ];

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <style>{`.tab-btn:hover { color: ${T.textPrimary} !important; }`}</style>
      <div style={{
        display: 'flex', gap: '2px',
        padding: '6px 8px',
        borderBottom: `1px solid ${T.border}`,
        flexShrink: 0,
      }}>
        {tabs.map(({ key, label, count }) => (
          <button
            key={key}
            className="tab-btn"
            onClick={() => setTab(key)}
            style={{
              flex: 1, padding: '4px 0',
              background: tab === key ? T.bgHover : 'none',
              border: `1px solid ${tab === key ? T.border : 'transparent'}`,
              borderRadius: T.radiusSm,
              color: tab === key ? T.textPrimary : T.textMuted,
              cursor: 'pointer', fontSize: '0.72rem', fontWeight: tab === key ? 600 : 400,
              fontFamily: T.fontSans, transition: 'all 0.12s',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
            }}
          >
            {label}
            {count > 0 && (
              <span style={{
                background: tab === key ? T.accentDim : 'rgba(128,128,128,0.12)',
                color: tab === key ? T.accent : T.textMuted,
                borderRadius: T.radiusPill,
                padding: '0 5px', fontSize: '0.62rem', fontWeight: 600,
              }}>{count}</span>
            )}
          </button>
        ))}
      </div>

      {sharingSession && <SessionSharing token={token} session={sharingSession} onClose={() => setSharingSession(null)} />}
      {tab === 'running' && <RunningTab onShare={setSharingSession} activeSessions={activeSessions} foldersByMachine={foldersByMachine} openTerminals={openTerminals} active={active} onOpen={onOpen} onStop={onStop} onClose={onClose} onRenameSession={onRenameSession} onMoveSession={onMoveSession} onCreateFolder={onCreateFolder} onRenameFolder={onRenameFolder} onDeleteFolder={onDeleteFolder} onMoveFolder={onMoveFolder} />}
      {tab === 'history' && <HistoryTab historySessions={historySessions} active={active} onOpen={onOpen} onDelete={onDelete} />}
      {tab === 'files'   && <FileBrowser ws={ws} machineId={machineId} machines={machines} historySessions={historySessions} onLaunch={onLaunch} onPreviewMd={onPreviewMd} onSelectMachine={onSelectMachine} />}
    </div>
  );
}
