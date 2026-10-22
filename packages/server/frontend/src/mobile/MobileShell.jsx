import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '../theme';
import { createSessionId, getLaunchCommand } from '../launch-config';
import {
  resolveDefaultMachine, loadPreferredMachine, savePreferredMachine, saveLastDir,
} from '../machine-prefs';
import { getRunningSessionTitle } from '../session-list-utils';
import useRelay from './useRelay';
import MobileSessionList from './MobileSessionList';
import MobileTerminal from './MobileTerminal';
import Avatar from '../Avatar';
import ProfileModal from '../ProfileModal';

// 手机版主界面。两种形态：
//  · 一个终端都没开 → 会话列表铺满整屏（手机上「先选会话」就是首页）
//  · 有终端 → 终端铺满，会话列表变成从左侧划出的抽屉
// 已打开的终端全部保持挂载（只有当前那个 display:flex），切回来时 xterm 的内容还在；
// 隐藏的面板量不到尺寸，所以它们既不会开 PTY 也不会参与尺寸协商（见 MobileTerminal）。

// 手机版自己的打开列表。不与桌面版共用 'openTerminals' —— 同一个浏览器里两个页面
// 各管各的标签，手机上随手关一个不该把桌面的工作区也改了。
const OPEN_KEY = 'mobileOpenTerminals';
const ACTIVE_KEY = 'mobileActiveSession';

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

const TOPBAR_BTN = (T) => ({
  minWidth: '44px', minHeight: '44px',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'none', border: 'none', color: T.textSecondary,
  fontSize: '1.05rem', flexShrink: 0,
});

export default function MobileShell({ token, onAuthFailed, isDark, onToggleTheme }) {
  const T = useTheme();
  const [openTerminals, setOpenTerminals] = useState(() => readJson(OPEN_KEY, []));
  const [activeSessionId, setActiveSessionId] = useState(() => localStorage.getItem(ACTIVE_KEY) || null);
  // 只存「用户明确选过什么」：null = 从没选过，'' = 明确选了「所有开发机」。
  // 真正生效的机器由 resolveDefaultMachine 从它和在线列表推出来（见下面的 selectedMachine），
  // 不用 effect 去回写 state —— 那会多一轮渲染，且选中的机器掉线时容易和列表打架。
  const [savedMachine, setSavedMachine] = useState(loadPreferredMachine);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 个人信息（昵称 / 头像）。和桌面版同一个接口、同一个弹窗，改完两边一致。
  const [profile, setProfile] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : null))
      .then(p => { if (!cancelled && p) setProfile(p); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [token]);

  // 关闭一个标签（不杀进程）。relay 判定归属被拒时（pty_error）也走这里，
  // 而那是个 ws 回调，拿到的是首次渲染的旧闭包 —— 所以读的是 ref 而不是 state。
  // 关掉的正好是当前那个时，接力给剩下的第一个，别让界面空在那儿。
  const openTerminalsRef = useRef(openTerminals);
  useEffect(() => { openTerminalsRef.current = openTerminals; }, [openTerminals]);

  const closeTab = useCallback((machineId, sessionId) => {
    const remaining = openTerminalsRef.current.filter(t => t.sessionId !== sessionId);
    setOpenTerminals(remaining);
    setActiveSessionId(cur => (cur !== sessionId ? cur : (remaining[0]?.sessionId || null)));
  }, []);

  // 会话改名成功后 sessionId 会变（sessionId 就是开发机上的 tmux 名）。开着的标签
  // 必须跟着换名字，否则它指着一个已经不存在的名字：手机一切后台就重连，重连时
  // 那个标签会照旧名发 open_terminal，开发机找不到就**新建**一个空会话。
  // 与 closeTab 同理，这是 ws 回调里调的，读 ref 而不是 state。
  const handleSessionRenamed = useCallback((machineId, oldSessionId, newSessionId) => {
    if (!oldSessionId || !newSessionId || oldSessionId === newSessionId) return;
    // 按 machineId + sessionId 匹配：sessionId 是 tmux 名，两台机器上重名很常见（main、dev…）
    setOpenTerminals(openTerminalsRef.current.map(t => (
      t.sessionId === oldSessionId && t.machineId === machineId
        // 命令里也可能带着旧名（`claude --resume <id>`），一起换掉
        ? { ...t, sessionId: newSessionId, command: t.command?.map(a => (a === oldSessionId ? newSessionId : a)) }
        : t
    )));
    setActiveSessionId(cur => (cur === oldSessionId ? newSessionId : cur));
  }, []);

  const {
    ws, wsReady, machines: onlineMachines, activeSessions, stopSession, username,
    foldersByMachine, actionError, clearActionError,
    renameSession, moveSession, createFolder, renameFolder, deleteFolder, moveFolder,
  } = useRelay(token, {
    onAuthFailed,
    onSessionDenied: closeTab,
    onSessionRenamed: handleSessionRenamed,
  });

  useEffect(() => { localStorage.setItem(OPEN_KEY, JSON.stringify(openTerminals)); }, [openTerminals]);
  useEffect(() => {
    if (activeSessionId) localStorage.setItem(ACTIVE_KEY, activeSessionId);
    else localStorage.removeItem(ACTIVE_KEY);
  }, [activeSessionId]);

  // 机器列表：在线机器为准，会话数从 active_sessions 算
  const machines = useMemo(() => {
    const map = new Map();
    for (const m of onlineMachines) {
      map.set(m.machineId, { machineId: m.machineId, defaultWorkDir: m.defaultWorkDir || '', sessionCount: 0 });
    }
    for (const s of activeSessions) {
      if (!map.has(s.machineId)) map.set(s.machineId, { machineId: s.machineId, defaultWorkDir: '', sessionCount: 0 });
      map.get(s.machineId).sessionCount += 1;
    }
    return Array.from(map.values());
  }, [onlineMachines, activeSessions]);

  // 当前该看哪台开发机：用户上次的选择 → 主力开发机 → 第一台在线的。
  // 选中的机器掉线时自动回落，否则列表空着还没有任何提示。
  const selectedMachine = useMemo(
    () => resolveDefaultMachine(machines, savedMachine),
    [machines, savedMachine]
  );

  const visibleSessions = useMemo(() => (
    selectedMachine ? activeSessions.filter(s => s.machineId === selectedMachine) : activeSessions
  ), [activeSessions, selectedMachine]);

  const openSessionIds = useMemo(() => new Set(openTerminals.map(t => t.sessionId)), [openTerminals]);

  // 真正显示哪个终端。localStorage 里记的那个可能已经不在列表里了（上次在别处关掉的），
  // 硬按它渲染会得到「有终端却一个都不可见」的白屏 —— 落回第一个。
  const activeTerminal = useMemo(() => (
    openTerminals.find(t => t.sessionId === activeSessionId) || openTerminals[0] || null
  ), [openTerminals, activeSessionId]);
  const visibleSessionId = activeTerminal?.sessionId || null;

  function chooseMachine(mid) {
    setSavedMachine(mid);
    savePreferredMachine(mid);
  }

  function openTerminal(machineId, sessionId, command, cwd) {
    const launchCommand = getLaunchCommand(command);
    setOpenTerminals(prev => (
      prev.some(t => t.sessionId === sessionId)
        ? prev
        : [...prev, { machineId, sessionId, cwd, command: launchCommand }]
    ));
    setActiveSessionId(sessionId);
    setDrawerOpen(false);
  }

  function createSession(machineId, cwd, command) {
    const launchCommand = getLaunchCommand(command);
    saveLastDir(machineId, cwd);
    // open_terminal 由 MobileTerminal 在注册 listener 之后发送（保证时序）
    openTerminal(machineId, createSessionId(launchCommand), launchCommand, cwd);
  }

  function handleStop(machineId, sessionId) {
    if (!window.confirm('停止这个会话？里面正在跑的进程会一起结束。')) return;
    stopSession(machineId, sessionId);
    closeTab(machineId, sessionId);
  }

  const activeSession = activeSessions.find(s => s.sessionId === visibleSessionId);
  const title = activeSession
    ? getRunningSessionTitle(activeSession)
    : (activeTerminal ? activeTerminal.sessionId : 'VibeAnything');

  const sessionListProps = {
    machines,
    selectedMachine,
    onSelectMachine: chooseMachine,
    sessions: visibleSessions,
    openSessionIds,
    activeSessionId: visibleSessionId,
    onOpen: openTerminal,
    onCloseTab: closeTab,
    onStop: handleStop,
    onCreate: createSession,
    onRenameSession: renameSession,
    // 文件夹树按机器取：每台开发机各维护自己的一份（服务端 session-metadata）
    folders: foldersByMachine[selectedMachine] || [],
    onMoveSession: moveSession,
    onCreateFolder: createFolder,
    onRenameFolder: renameFolder,
    onDeleteFolder: deleteFolder,
    onMoveFolder: moveFolder,
    actionError,
    onClearActionError: clearActionError,
  };

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: 'var(--app-height)', width: '100%', overflow: 'hidden',
      background: T.bgBase, color: T.textPrimary, fontFamily: T.fontSans,
      // 刘海/横屏时的左右耳朵：内容不能压到物理边缘之外
      paddingTop: 'var(--safe-top)',
      paddingLeft: 'var(--safe-left)',
      paddingRight: 'var(--safe-right)',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '4px',
        padding: '2px 4px', borderBottom: `1px solid ${T.border}`,
        background: T.bgPanel, flexShrink: 0,
      }}>
        <button
          type="button"
          onClick={() => setDrawerOpen(v => !v)}
          title="会话列表"
          aria-label="会话列表"
          style={TOPBAR_BTN(T)}
        >☰</button>
        {/* 站点图标那一格改成当前用户的头像，点开就是个人信息 ——
            手机版顶栏只有这么宽，塞不下第二个入口。没设过头像时显示的还是那只兔子。 */}
        <button
          type="button"
          onClick={() => setProfileOpen(true)}
          title="个人信息"
          aria-label="个人信息"
          style={{ ...TOPBAR_BTN(T), minWidth: '34px' }}
        >
          <Avatar profile={profile || { username }} size={22} radius="50%" />
        </button>
        <span style={{
          flex: 1, minWidth: 0, fontSize: '0.85rem', fontWeight: 600,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{title}</span>
        <span
          title={wsReady ? '已连接' : '连接中…'}
          style={{
            width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0, marginRight: '4px',
            background: wsReady ? T.success : T.danger,
            animation: wsReady ? 'none' : 'pulse 1.5s infinite',
          }}
        />
        <button type="button" onClick={onToggleTheme} title="切换主题" aria-label="切换主题" style={TOPBAR_BTN(T)}>
          {isDark ? '☀' : '🌙'}
        </button>
        {/* 顶栏不放退出按钮（用户 2026-09-22 明确要求去掉）：它紧挨着高频的主题按钮，
            误触一下就要重登一次。token 被撤销时 useRelay 收到 4001 → 续期被拒 → 自动退出登录，
            那条路不受影响。要手动退出去桌面版。 */}
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        {openTerminals.length === 0 ? (
          <MobileSessionList {...sessionListProps} token={token} />
        ) : (
          openTerminals.map(t => (
            <MobileTerminal
              key={t.sessionId}
              machineId={t.machineId}
              sessionId={t.sessionId}
              command={t.command}
              cwd={t.cwd}
              ws={ws}
              visible={t.sessionId === visibleSessionId}
            />
          ))
        )}

        {drawerOpen && openTerminals.length > 0 && (
          <>
            <div
              onClick={() => setDrawerOpen(false)}
              style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 40 }}
            />
            <div style={{
              position: 'absolute', top: 0, bottom: 0, left: 0, zIndex: 41,
              width: 'min(86%, 360px)',
              boxShadow: '4px 0 24px rgba(0,0,0,0.5)',
              display: 'flex', flexDirection: 'column',
            }}>
              <MobileSessionList {...sessionListProps} token={token} />
            </div>
          </>
        )}
      </div>

      {profileOpen && (
        <ProfileModal
          token={token}
          profile={profile || { username }}
          fullscreen
          onClose={() => setProfileOpen(false)}
          onSaved={setProfile}
        />
      )}

      {/* relay 断线时给一条明确提示：手机常在弱网/切后台，静默重连会让人以为终端卡死 */}
      {!wsReady && (
        <div style={{
          position: 'fixed', bottom: 'calc(8px + var(--safe-bottom))', left: '50%',
          transform: 'translateX(-50%)', zIndex: 60,
          background: T.dangerDim, border: `1px solid ${T.danger}`, color: T.danger,
          borderRadius: T.radiusPill, padding: '4px 14px', fontSize: '0.72rem',
          pointerEvents: 'none',
        }}>连接中断，正在重连…</div>
      )}
    </div>
  );
}
