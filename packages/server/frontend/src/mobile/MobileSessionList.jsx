import { useMemo, useState } from 'react';
import { useTheme } from '../theme';
import { CLI_CMDS, DEFAULT_LAUNCH_COMMAND } from '../launch-config';
import { loadLastDir } from '../machine-prefs';
import {
  buildSessionTree, flattenFolderPaths, isDescendant,
  partitionByOwner, shouldGroupByOwner, sortOwnerKeys, UNOWNED_OWNER_KEY,
} from '../folder-tree';
import useFolderCollapse from '../useFolderCollapse';
import SessionSharing from '../SessionSharing';
import { MobileActionSheet, MobilePromptSheet } from './MobileSheet';
import {
  getRunningSessionTitle, getRunningSessionDetail, getRunningSessionCommand,
} from '../session-list-utils';

// 手机版的机器选择 + 会话列表（带文件夹分组）+ 新建会话。
//
// 分组数据与桌面版是同一份（服务端 session-metadata 维护，folders 消息下发），
// 两边看到的树一模一样；不同的是**怎么操作**：
//
//  · 桌面版靠拖拽把会话拖进文件夹、靠右键菜单改名删除。
//  · 手机上这两样都不能照搬：拖拽库的 sensor 会和列表滚动抢同一串 touch 事件
//    （2026-08-23 的「会话列表滑不动」就是这么来的），右键菜单在触屏上根本不存在。
//    所以这里一律走「点 ⋯ → 底部面板里选」——不抢手势，目标也比拖一段距离更准。

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

const ROW_MIN_HEIGHT = 56;   // 手指点得准的行高
const INDENT_PX = 14;        // 每层缩进。手机屏窄，比桌面版小一档，免得深层会话只剩一条缝
const ROOT_FOLDER_KEY = '__root__';

/** 一个文件夹（含所有子孙）里有多少会话 —— 折叠起来时也能一眼看出里面有没有东西。 */
function countSessions(node) {
  return node.sessions.length + node.children.reduce((n, c) => n + countSessions(c), 0);
}

/** 子孙里有没有正在跑的会话 —— 折叠时也要能看见「里面有活儿」。 */
function hasRunning(node) {
  return node.sessions.some(s => s.isRunning) || node.children.some(hasRunning);
}

function MachineChips({ machines, selected, onSelect, T }) {
  return (
    <div style={{
      display: 'flex', gap: '6px', padding: '8px 12px',
      overflowX: 'auto', WebkitOverflowScrolling: 'touch',
      borderBottom: `1px solid ${T.border}`, flexShrink: 0,
    }}>
      {machines.map(m => {
        const active = selected === m.machineId;
        return (
          <button
            key={m.machineId}
            type="button"
            onClick={() => onSelect(m.machineId)}
            style={{
              flexShrink: 0, minHeight: '36px',
              padding: '6px 14px', borderRadius: T.radiusPill,
              background: active ? T.accentDim : 'transparent',
              border: `1px solid ${active ? T.borderAccent : T.border}`,
              color: active ? T.accent : T.textSecondary,
              fontSize: '0.8rem', fontWeight: 500, fontFamily: T.fontSans,
              whiteSpace: 'nowrap',
            }}
          >
            {m.machineId}
            <span style={{ color: T.textMuted, marginLeft: '6px', fontSize: '0.72rem' }}>{m.sessionCount}</span>
          </button>
        );
      })}
      {machines.length === 0 && (
        <span style={{ color: T.textMuted, fontSize: '0.8rem', padding: '6px 2px' }}>没有在线的开发机</span>
      )}
    </div>
  );
}

function NewSessionPanel({ machine, onCreate, onCancel, cwdSuggestions, T }) {
  const [cwd, setCwd] = useState(
    () => loadLastDir(machine?.machineId) || machine?.defaultWorkDir || ''
  );
  const [cmdLabel, setCmdLabel] = useState(CLI_CMDS[0]?.label || DEFAULT_LAUNCH_COMMAND[0]);

  const canCreate = !!machine && !!cwd.trim();
  const inputStyle = {
    width: '100%', padding: '10px 12px', minHeight: '44px',
    borderRadius: T.radiusSm, border: `1px solid ${T.border}`,
    background: T.bgInput, color: T.textPrimary,
    // 16px 以下 iOS Safari 一聚焦就整页放大
    fontSize: '16px', fontFamily: T.fontMono, outline: 'none',
  };

  return (
    <div style={{ padding: '12px', borderBottom: `1px solid ${T.border}`, background: T.bgCard }}>
      <div style={{ fontSize: '0.72rem', color: T.textMuted, marginBottom: '6px' }}>启动命令</div>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
        {CLI_CMDS.map(({ label }) => (
          <button
            key={label}
            type="button"
            onClick={() => setCmdLabel(label)}
            style={{
              minHeight: '38px', padding: '6px 14px', borderRadius: T.radiusPill,
              background: cmdLabel === label ? T.accentDim : 'transparent',
              border: `1px solid ${cmdLabel === label ? T.borderAccent : T.border}`,
              color: cmdLabel === label ? T.accent : T.textSecondary,
              fontSize: '0.8rem', fontFamily: T.fontMono,
            }}
          >{label}</button>
        ))}
      </div>

      <div style={{ fontSize: '0.72rem', color: T.textMuted, marginBottom: '6px' }}>工作目录（开发机上的绝对路径）</div>
      <input
        value={cwd}
        onChange={e => setCwd(e.target.value)}
        placeholder="/home/you/project"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        style={inputStyle}
      />
      {cwdSuggestions.length > 0 && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
          {cwdSuggestions.map(dir => (
            <button
              key={dir}
              type="button"
              onClick={() => setCwd(dir)}
              title={dir}
              style={{
                minHeight: '32px', maxWidth: '100%', padding: '4px 10px',
                borderRadius: T.radiusPill, border: `1px solid ${T.border}`,
                background: 'transparent', color: T.textSecondary,
                fontSize: '0.72rem', fontFamily: T.fontMono,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >{dir}</button>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <button
          type="button"
          onClick={onCancel}
          style={{
            flex: 1, minHeight: '44px', borderRadius: T.radiusSm,
            border: `1px solid ${T.border}`, background: 'transparent',
            color: T.textSecondary, fontSize: '0.85rem', fontFamily: T.fontSans,
          }}
        >取消</button>
        <button
          type="button"
          disabled={!canCreate}
          onClick={() => onCreate(machine.machineId, cwd.trim(), CLI_CMDS.find(c => c.label === cmdLabel)?.cmd || DEFAULT_LAUNCH_COMMAND)}
          style={{
            flex: 2, minHeight: '44px', borderRadius: T.radiusSm, border: 'none',
            background: canCreate ? T.accent : T.bgHover,
            color: canCreate ? '#fff' : T.textMuted,
            fontSize: '0.85rem', fontWeight: 600, fontFamily: T.fontSans,
          }}
        >在这里启动</button>
      </div>
    </div>
  );
}

function FolderRow({ node, depth, collapsed, onToggle, onMenu, T }) {
  const total = countSessions(node);
  const running = hasRunning(node);
  return (
    <div
      onClick={() => onToggle(node.id)}
      aria-label={`文件夹 ${node.name}`}
      style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        minHeight: '46px', padding: `8px 4px 8px ${10 + depth * INDENT_PX}px`,
        borderBottom: `1px solid ${T.border}`,
        background: T.bgCard,
      }}
    >
      {/* 折叠箭头。整行都能点，箭头只是指示 —— 手机上别做只有 20px 宽的点击目标 */}
      <span style={{
        color: T.textMuted, fontSize: '0.7rem', width: '12px', flexShrink: 0,
        transform: collapsed ? 'none' : 'rotate(90deg)', transition: 'transform 0.12s',
      }}>▶</span>
      <span style={{ flexShrink: 0, fontSize: '0.9rem' }}>{collapsed ? '📁' : '📂'}</span>
      <span style={{
        flex: 1, minWidth: 0, color: T.textPrimary, fontSize: '0.85rem', fontWeight: 600,
        fontFamily: T.fontSans, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{node.name}</span>
      {/* 折叠状态下里面有正在跑的会话时点一下，免得把活儿藏起来看不见 */}
      {collapsed && running && (
        <span style={{
          width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0,
          background: T.danger, boxShadow: `0 0 5px ${T.danger}`,
        }} />
      )}
      <span style={{ color: T.textMuted, fontSize: '0.72rem', flexShrink: 0 }}>{total}</span>
      <button
        type="button"
        aria-label={`文件夹操作 ${node.name}`}
        onClick={(e) => { e.stopPropagation(); onMenu(node); }}
        style={{
          minWidth: '40px', minHeight: '40px', flexShrink: 0,
          background: 'none', border: 'none', color: T.textMuted, fontSize: '1rem',
        }}
      >⋯</button>
    </div>
  );
}

function SessionRow({ session, machineId, depth, isOpen, isActive, onOpen, onCloseTab, onMenu, T }) {
  return (
    <div
      onClick={() => onOpen(machineId, session.sessionId, getRunningSessionCommand(session), session.cwd)}
      style={{
        display: 'flex', alignItems: 'center', gap: '10px',
        minHeight: `${ROW_MIN_HEIGHT}px`, padding: `10px 4px 10px ${12 + depth * INDENT_PX}px`,
        borderBottom: `1px solid ${T.border}`,
        background: isActive ? T.accentDim : (isOpen ? T.bgHover : 'transparent'),
        borderLeft: `3px solid ${isActive ? T.accent : 'transparent'}`,
      }}
    >
      {/* 红绿灯：isRunning=true → 红（Claude 正在跑），false → 绿（空闲）。
          完全由开发机侧的 hook 驱动，与桌面版同一个字段。 */}
      <span
        title={session.isRunning ? '运行中' : '空闲'}
        style={{
          width: '9px', height: '9px', borderRadius: '50%', flexShrink: 0,
          background: session.isRunning ? T.danger : T.success,
          boxShadow: `0 0 5px ${session.isRunning ? T.danger : T.success}`,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          color: T.textPrimary, fontSize: '0.88rem', fontWeight: 500,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{getRunningSessionTitle(session)}{session.sharedBy && <span style={{ color: T.accent, marginLeft: 6, fontSize: '0.7rem' }}>共享</span>}</div>
        <div style={{
          color: T.textMuted, fontSize: '0.7rem', fontFamily: T.fontMono,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{getRunningSessionDetail(session)}</div>
      </div>
      <span style={{ color: T.textMuted, fontSize: '0.68rem', flexShrink: 0 }}>{timeAgo(session.mtime)}</span>
      {isOpen && (
        <button
          type="button"
          title="关闭标签（不杀进程）"
          aria-label="关闭标签"
          onClick={(e) => { e.stopPropagation(); onCloseTab(machineId, session.sessionId); }}
          style={{
            minWidth: '38px', minHeight: '38px', flexShrink: 0,
            background: 'none', border: 'none', color: T.textMuted, fontSize: '0.9rem',
          }}
        >✕</button>
      )}
      {/* 「停止会话」挪进了这个面板：它会杀掉里面跑的进程，不该在手指常扫过的行尾
          放一个一碰就中的按钮。「移动到文件夹」也在这里。 */}
      <button
        type="button"
        aria-label="会话操作"
        onClick={(e) => { e.stopPropagation(); onMenu(session); }}
        style={{
          minWidth: '38px', minHeight: '38px', flexShrink: 0,
          background: 'none', border: 'none', color: T.textMuted, fontSize: '1rem',
        }}
      >⋯</button>
    </div>
  );
}

export default function MobileSessionList({
  token, selfUsername,
  machines, selectedMachine, onSelectMachine,
  sessions, openSessionIds, activeSessionId,
  onOpen, onCloseTab, onStop, onCreate, onRenameSession,
  folders = [],
  onMoveSession, onCreateFolder, onRenameFolder, onDeleteFolder, onMoveFolder,
  actionError, onClearActionError,
}) {
  const T = useTheme();
  const [creating, setCreating] = useState(false);
  // 一个底部面板一次只开一个：{ kind, ... }
  const [sheet, setSheet] = useState(null);
  const { isCollapsed, toggle } = useFolderCollapse(selectedMachine);

  const machine = useMemo(
    () => machines.find(m => m.machineId === selectedMachine) || null,
    [machines, selectedMachine]
  );

  const { rootFolders, rootSessions } = useMemo(
    () => buildSessionTree(folders, sessions),
    [folders, sessions]
  );

  const folderPaths = useMemo(() => flattenFolderPaths(folders), [folders]);

  // 管理员看全部会话：这台机器上的会话再按归属人分段（不需要分组时为 null，规则同桌面版）
  const ownerSections = useMemo(() => {
    const parts = partitionByOwner(folders, sessions);
    if (!shouldGroupByOwner(parts.keys(), sessions, selfUsername)) return null;
    return sortOwnerKeys(parts.keys(), selfUsername).map(owner => ({
      owner, count: parts.get(owner).sessions.length,
      ...buildSessionTree(parts.get(owner).folders, parts.get(owner).sessions),
    }));
  }, [folders, sessions, selfUsername]);

  // 新建会话时的目录快捷选项：这台机器上已有会话的 cwd（最常见的就是接着在同一个项目里开一个）
  const cwdSuggestions = useMemo(() => {
    const seen = [];
    for (const s of sessions) {
      const dir = String(s.cwd || '').trim();
      if (dir && !seen.includes(dir)) seen.push(dir);
    }
    return seen.slice(0, 6);
  }, [sessions]);

  const close = () => setSheet(null);

  // ── 会话行的 ⋯ ──
  function openSessionMenu(session) {
    setSheet({ kind: 'session', session });
  }

  function sessionMenuItems(session) {
    const items = [{
      key: 'rename',
      label: '重命名',
      hint: '改 tmux 名',
      onSelect: () => setSheet({ kind: 'rename-session', session }),
    }, {
      key: 'move',
      label: '移动到文件夹…',
      hint: folderPaths.find(f => f.id === session.folderId)?.label || '未分组',
      onSelect: () => setSheet({ kind: 'move-session', session }),
    }];
    if (session.canShare) {
      items.unshift({ key: 'share', label: '共享窗口…', onSelect: () => setSheet({ kind: 'share', session }) });
    }
    if (openSessionIds.has(session.sessionId)) {
      items.push({
        key: 'close',
        label: '关闭标签（不杀进程）',
        onSelect: () => { close(); onCloseTab(session.machineId, session.sessionId); },
      });
    }
    items.push({
      key: 'stop',
      label: '停止会话',
      hint: '杀掉里面跑的进程',
      danger: true,
      onSelect: () => { close(); onStop(session.machineId, session.sessionId); },
    });
    return items;
  }

  // ── 文件夹行的 ⋯ ──
  function folderMenuItems(node) {
    return [
      {
        key: 'new-child',
        label: '在里面新建子文件夹',
        onSelect: () => setSheet({ kind: 'create-folder', parentId: node.id, parentName: node.name }),
      },
      {
        key: 'rename',
        label: '重命名',
        onSelect: () => setSheet({ kind: 'rename-folder', node }),
      },
      {
        key: 'move',
        label: '移动到…',
        onSelect: () => setSheet({ kind: 'move-folder', node }),
      },
      {
        key: 'delete',
        label: '删除文件夹',
        hint: '里面的东西挪到上一层',
        danger: true,
        onSelect: () => {
          close();
          // 删除不丢会话（服务端把子文件夹和会话提到上一层），但树结构变了要确认一下
          if (window.confirm(`删除文件夹「${node.name}」？里面的会话和子文件夹会挪到上一层，不会被杀掉。`)) {
            onDeleteFolder(selectedMachine, node.id);
          }
        },
      },
    ];
  }

  // ── 目标选择：根目录 + 全部文件夹（带层级路径）──
  function targetItems({ currentId, excludeId }) {
    const items = [{
      key: ROOT_FOLDER_KEY,
      label: '根目录（不分组）',
      checked: !currentId,
      onSelect: () => pickTarget(null),
    }];
    for (const f of folderPaths) {
      // 移动文件夹时要排掉自己和自己的子树，否则树会成环
      if (excludeId && (f.id === excludeId || isDescendant(folders, f.id, excludeId))) continue;
      items.push({
        key: f.id,
        label: f.name,
        indent: f.depth,
        checked: currentId === f.id,
        onSelect: () => pickTarget(f.id),
      });
    }
    return items;
  }

  function pickTarget(folderId) {
    if (sheet?.kind === 'move-session') onMoveSession(sheet.session.machineId, sheet.session.sessionId, folderId);
    else if (sheet?.kind === 'move-folder') onMoveFolder(selectedMachine, sheet.node.id, folderId);
    close();
  }

  // ── 递归渲染一层 ──
  // keyPrefix：分段显示时同一个文件夹可能作为祖先出现在几段里，React key 要带段名
  function renderFolder(node, depth, keyPrefix = '') {
    const collapsed = isCollapsed(node.id);
    const rows = [
      <FolderRow
        key={`${keyPrefix}f:${node.id}`}
        node={node} depth={depth} collapsed={collapsed}
        onToggle={toggle}
        onMenu={(n) => setSheet({ kind: 'folder', node: n })}
        T={T}
      />,
    ];
    if (collapsed) return rows;
    for (const child of node.children) rows.push(...renderFolder(child, depth + 1, keyPrefix));
    for (const s of node.sessions) rows.push(renderSession(s, depth + 1));
    if (node.children.length === 0 && node.sessions.length === 0) {
      rows.push(
        <div key={`${keyPrefix}e:${node.id}`} style={{
          padding: `8px 12px 8px ${12 + (depth + 1) * INDENT_PX}px`,
          color: T.textMuted, fontSize: '0.74rem',
          borderBottom: `1px solid ${T.border}`,
        }}>空文件夹 —— 在会话的 ⋯ 里选「移动到文件夹」放东西进来</div>
      );
    }
    return rows;
  }

  function renderSession(s, depth) {
    return (
      <SessionRow
        key={`${s.machineId}:${s.sessionId}`}
        session={s}
        machineId={s.machineId}
        depth={depth}
        isOpen={openSessionIds.has(s.sessionId)}
        isActive={activeSessionId === s.sessionId}
        onOpen={onOpen}
        onCloseTab={onCloseTab}
        onMenu={openSessionMenu}
        T={T}
      />
    );
  }

  const headerBtn = (extra = {}) => ({
    minHeight: '36px', padding: '6px 12px', borderRadius: T.radiusPill,
    border: `1px solid ${machine ? T.borderAccent : T.border}`,
    background: 'transparent',
    color: machine ? T.accent : T.textMuted,
    fontSize: '0.78rem', fontWeight: 600, fontFamily: T.fontSans,
    whiteSpace: 'nowrap',
    ...extra,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: T.bgPanel }}>
      <MachineChips machines={machines} selected={selectedMachine} onSelect={onSelectMachine} T={T} />

      <div style={{
        display: 'flex', alignItems: 'center', gap: '6px',
        padding: '8px 12px', borderBottom: `1px solid ${T.border}`, flexShrink: 0,
      }}>
        <span style={{
          flex: 1, minWidth: 0, fontSize: '0.7rem', fontWeight: 600, color: T.textMuted,
          letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>会话 {sessions.length}</span>
        <button
          type="button"
          disabled={!machine}
          onClick={() => setSheet({ kind: 'create-folder', parentId: null })}
          style={headerBtn()}
        >＋ 文件夹</button>
        <button
          type="button"
          onClick={() => setCreating(v => !v)}
          disabled={!machine}
          style={headerBtn(creating ? { background: T.accentDim } : {})}
        >{creating ? '收起' : '＋ 新建'}</button>
      </div>

      {actionError && (
        <div
          onClick={onClearActionError}
          style={{
            padding: '8px 12px', background: T.dangerDim, color: T.danger,
            fontSize: '0.76rem', fontFamily: T.fontSans, flexShrink: 0,
            borderBottom: `1px solid ${T.border}`,
          }}
        >{actionError}（点一下关掉）</div>
      )}

      {creating && machine && (
        <NewSessionPanel
          machine={machine}
          cwdSuggestions={cwdSuggestions}
          onCancel={() => setCreating(false)}
          onCreate={(mid, cwd, cmd) => { setCreating(false); onCreate(mid, cwd, cmd); }}
          T={T}
        />
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {ownerSections ? ownerSections.flatMap(sec => [
          <div key={`o:${sec.owner}`} style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            padding: '8px 12px', background: T.bgCard,
            borderBottom: `1px solid ${T.border}`,
            color: sec.owner === UNOWNED_OWNER_KEY ? T.warning : T.textPrimary,
            fontSize: '0.78rem', fontWeight: 700, fontFamily: T.fontSans,
          }}>
            <span aria-hidden="true">👤</span>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {sec.owner === UNOWNED_OWNER_KEY ? '无主' : sec.owner === selfUsername ? `${sec.owner}（我）` : sec.owner}
            </span>
            <span style={{ fontSize: '0.68rem', fontWeight: 400, color: T.textMuted }}>{sec.count} 会话</span>
          </div>,
          ...sec.rootFolders.flatMap(node => renderFolder(node, 0, `${sec.owner}/`)),
          ...sec.rootSessions.map(s => renderSession(s, 0)),
        ]) : (
          <>
            {rootFolders.flatMap(node => renderFolder(node, 0))}
            {rootSessions.map(s => renderSession(s, 0))}
          </>
        )}
        {sessions.length === 0 && rootFolders.length === 0 && (
          <div style={{ padding: '32px 16px', textAlign: 'center', color: T.textMuted, fontSize: '0.85rem' }}>
            这台开发机上没有运行中的会话，点右上角「＋ 新建」开一个
          </div>
        )}
      </div>

      {sheet?.kind === 'share' && <SessionSharing token={token} session={sheet.session} onClose={close} />}
      {sheet?.kind === 'session' && (
        <MobileActionSheet
          title={getRunningSessionTitle(sheet.session)}
          subtitle={sheet.session.cwd}
          items={sessionMenuItems(sheet.session)}
          onClose={close}
        />
      )}
      {sheet?.kind === 'move-session' && (
        <MobileActionSheet
          title="移动到文件夹"
          subtitle={getRunningSessionTitle(sheet.session)}
          items={targetItems({ currentId: sheet.session.folderId })}
          onClose={close}
        />
      )}
      {sheet?.kind === 'folder' && (
        <MobileActionSheet
          title={sheet.node.name}
          subtitle={`${countSessions(sheet.node)} 个会话`}
          items={folderMenuItems(sheet.node)}
          onClose={close}
        />
      )}
      {sheet?.kind === 'move-folder' && (
        <MobileActionSheet
          title="把文件夹移动到"
          subtitle={sheet.node.name}
          items={targetItems({ currentId: sheet.node.parentId, excludeId: sheet.node.id })}
          onClose={close}
        />
      )}
      {sheet?.kind === 'create-folder' && (
        <MobilePromptSheet
          title="新建文件夹"
          subtitle={sheet.parentName ? `建在「${sheet.parentName}」里` : '建在根目录'}
          placeholder="文件夹名"
          confirmLabel="创建"
          onConfirm={(name) => { close(); onCreateFolder(selectedMachine, name, sheet.parentId); }}
          onClose={close}
        />
      )}
      {sheet?.kind === 'rename-session' && (
        <MobilePromptSheet
          title="重命名会话"
          // 说清楚改的是什么：这不是给列表加个别名，是真去改开发机上的 tmux 会话名，
          // 名字里的 . : 空格会被换成 -，撞名会被开发机拒掉（错误走上面那条行内提示）。
          subtitle={`tmux 名 ${sheet.session.sessionId}`}
          initial={getRunningSessionTitle(sheet.session)}
          placeholder="会话名"
          onConfirm={(name) => { close(); onRenameSession(sheet.session.machineId, sheet.session.sessionId, name); }}
          onClose={close}
        />
      )}
      {sheet?.kind === 'rename-folder' && (
        <MobilePromptSheet
          title="重命名文件夹"
          initial={sheet.node.name}
          placeholder="文件夹名"
          onConfirm={(name) => { close(); onRenameFolder(selectedMachine, sheet.node.id, name); }}
          onClose={close}
        />
      )}
    </div>
  );
}
