import { useState, useEffect, useMemo } from 'react';
import { parseWsMessage } from './ws-message';
import { useTheme } from './theme';
import { CLI_CMDS } from './launch-config';
import { loadLastDir, saveLastDir } from './machine-prefs';
import { breadcrumbs, parentDir, basename } from './path-utils';

// 目录树里的小幽灵按钮（▶ 启动 / vim / ↑ 上级 / 🏠 家目录）同款
const iconBtn = (T, fontSize = '0.7rem') => ({
  background: 'none', border: `1px solid ${T.border}`,
  color: T.textMuted, borderRadius: '4px',
  cursor: 'pointer', padding: '1px 6px', fontSize,
  flexShrink: 0, transition: 'background-color 0.12s, border-color 0.12s, color 0.12s, opacity 0.12s, box-shadow 0.12s',
});

function LaunchMenu({ path, onLaunch, T }) {
  const [open, setOpen] = useState(false);

  function handleOpen(e) {
    e.stopPropagation();
    setOpen(v => !v);
  }

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    // position:relative 作为 dropdown 的定位基准，避免受父级 transform 影响
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <button
        className="dir-launch"
        title={`在 ${path} 启动`}
        onClick={handleOpen}
        style={iconBtn(T, '0.65rem')}
      >▶</button>
      {open && (
        // 向右下方弹出，right:0 对齐按钮右边，确保不超出侧边栏
        <div style={{
          position: 'absolute',
          top: '100%', right: 0,
          marginTop: '2px',
          display: 'flex', gap: '3px', zIndex: 100,
          background: T.bgCard,
          border: `1px solid ${T.border}`,
          borderRadius: '6px',
          padding: '4px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        }}>
          {CLI_CMDS.map(({ label, cmd }) => (
            <button
              key={label}
              onPointerDown={e => { e.stopPropagation(); onLaunch(path, cmd); setOpen(false); }}
              style={{
                background: 'none', border: `1px solid ${T.borderAccent}`,
                color: T.accent, borderRadius: '4px',
                cursor: 'pointer', padding: '3px 10px', fontSize: '0.72rem',
                fontFamily: 'monospace', whiteSpace: 'nowrap',
              }}
            >{label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function DirTree({ ws, machineId, rootPath, onLaunch, onPreviewMd, onNavigate }) {
  const T = useTheme();
  const [entries, setEntries]   = useState(null);
  const [expanded, setExpanded] = useState({});

  useEffect(() => {
    if (!ws || !machineId) return;
    const handler = (e) => {
      const msg = parseWsMessage(e);
      if (msg?.type === 'dir_entries' && msg.path === rootPath) {
        setEntries(msg.entries || []);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ type: 'list_dir', machineId, path: rootPath }));
    return () => ws.removeEventListener('message', handler);
  }, [ws, machineId, rootPath]);

  if (!entries) return (
    <div style={{ color: T.textMuted, fontSize: '0.72rem', padding: '0.25rem 0.75rem' }}>加载中…</div>
  );

  const isMd = (name) => name.endsWith('.md') || name.endsWith('.markdown');

  return (
    <div>
      <style>{`.dir-row:hover { background: ${T.bgHover} !important; } .dir-launch:hover { background: ${T.accentDim} !important; color: ${T.accent} !important; }`}</style>
      {entries.map(entry => (
        <div key={entry.path}>
          <div
            className="dir-row"
            style={{
              display: 'flex', alignItems: 'center', padding: '0.2rem 0.4rem',
              gap: '4px', borderRadius: T.radiusSm, cursor: 'pointer',
              transition: 'background 0.1s',
            }}
          >
            {entry.type === 'dir' ? (
              <>
                <span
                  onClick={() => setExpanded(p => ({ ...p, [entry.path]: !p[entry.path] }))}
                  style={{ color: T.textMuted, fontSize: '0.6rem', width: '10px', userSelect: 'none', flexShrink: 0 }}
                >
                  {expanded[entry.path] ? '▼' : '▶'}
                </span>
                <span style={{ fontSize: '0.72rem' }}>📁</span>
                <span
                  style={{ flex: 1, color: T.textSecondary, fontSize: '0.75rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
                  onClick={() => setExpanded(p => ({ ...p, [entry.path]: !p[entry.path] }))}
                  onDoubleClick={() => onNavigate?.(entry.path)}
                  title="单击展开，双击设为根目录"
                >
                  {entry.name}
                </span>
                <LaunchMenu path={entry.path} onLaunch={onLaunch} T={T} />
              </>
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
                <button
                  className="dir-launch"
                  title={`vim ${entry.path}`}
                  onClick={e => {
                    e.stopPropagation();
                    onLaunch(parentDir(entry.path), ['vim', entry.path]);
                  }}
                  style={iconBtn(T, '0.62rem')}
                >vim</button>
              </>
            )}
          </div>
          {entry.type === 'dir' && expanded[entry.path] && (
            <div style={{ paddingLeft: '14px' }}>
              <DirTree ws={ws} machineId={machineId} rootPath={entry.path} onLaunch={onLaunch} onPreviewMd={onPreviewMd} onNavigate={onNavigate} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function FileBrowser({ ws, machineId, machines, historySessions, onLaunch, onPreviewMd, onSelectMachine }) {
  const T = useTheme();
  // 机器选择不在这里另立一份：目录树与侧边栏会话共用 Dashboard 的选中机器（machineId
  // prop），否则两处各选各的，「在目录里启动」会落到你以为之外的机器上。
  const homeDir = (machines || []).find(mc => mc.machineId === machineId)?.defaultWorkDir || '';

  // 起始目录：这台机器上次浏览到哪就回哪 → 其次开发机配置的 defaultWorkDir
  // → 再次最近用过的目录 → 兜底根目录。
  const getInitialPath = (mid) => {
    const remembered = loadLastDir(mid);
    if (remembered) return remembered;
    const m = (machines || []).find(mc => mc.machineId === mid);
    if (m?.defaultWorkDir) return m.defaultWorkDir;
    const recent = [...new Set((historySessions || []).map(s => s.cwd).filter(Boolean))];
    return recent[0] || '/';
  };
  // treeRoot = 当前浏览的目录；draft = 用户正在输入的草稿（null 表示没在编辑）。
  // 两个 state 各自独立，不需要每次导航都成对同步。
  const [treeRoot, setTreeRoot] = useState(() => getInitialPath(machineId));
  const [draft, setDraft] = useState(null);
  const pathValue = draft ?? treeRoot;

  const goTo = (path) => {
    const p = String(path || '').trim();
    if (!p) return;
    setTreeRoot(p);
    setDraft(null);
    saveLastDir(machineId, p);
  };

  // 切换机器时回到该机器自己的起始目录（上次浏览的位置优先）
  useEffect(() => { goTo(getInitialPath(machineId)); }, [machineId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 始终携带当前选中机器启动，避免使用 Dashboard 侧边栏选中的机器
  const launchWithMachine = (path, cmd) => onLaunch(path, cmd, machineId);

  const recentDirs = useMemo(() => [...new Set((historySessions || [])
    .filter(s => !machineId || s.machineId === machineId)
    .map(s => s.cwd).filter(Boolean))].slice(0, 5), [historySessions, machineId]);

  return (
    <div style={{
      flex: 1, overflowY: 'auto',
      padding: '0.5rem',
      fontSize: '0.78rem',
    }}>
      <style>{`.recent-tag:hover { background: ${T.accentDim} !important; border-color: ${T.borderAccent} !important; color: ${T.accent} !important; } .path-input:focus { border-color: ${T.borderAccent} !important; box-shadow: 0 0 0 2px ${T.accentDim}; } .crumb:hover { background: ${T.bgHover} !important; color: ${T.accent} !important; }`}</style>

      {/* 开发机选择 */}
      {machines && machines.length > 1 && (
        <div style={{ marginBottom: '0.5rem' }}>
          <select
            value={machineId}
            onChange={e => onSelectMachine?.(e.target.value)}
            style={{
              width: '100%', padding: '3px 6px',
              background: T.bgBase, border: `1px solid ${T.border}`,
              borderRadius: T.radiusSm, color: T.textPrimary,
              fontSize: '0.75rem', cursor: 'pointer',
            }}
          >
            {machines.map(m => (
              <option key={m.machineId} value={m.machineId}>{m.machineId}</option>
            ))}
          </select>
        </div>
      )}

      {/* 最近目录 — 标签云 */}
      {recentDirs.length > 0 && (
        <div style={{ marginBottom: '0.6rem' }}>
          <div style={{ color: T.textMuted, fontSize: '0.65rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: '0.35rem' }}>最近</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            {recentDirs.map(dir => (
              <button
                key={dir}
                className="recent-tag"
                onClick={() => launchWithMachine(dir)}
                title={dir}
                style={{
                  background: T.bgHover, border: `1px solid ${T.border}`,
                  color: T.textSecondary, borderRadius: T.radiusPill,
                  cursor: 'pointer', padding: '2px 8px', fontSize: '0.68rem',
                  fontFamily: T.fontSans, transition: 'background-color 0.12s, border-color 0.12s, color 0.12s, opacity 0.12s, box-shadow 0.12s',
                  maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
              >
                {basename(dir)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 目录树 */}
      <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: '0.5rem' }}>
        {/* 面包屑：路径每一段都可点，跳上几级不用连按 ↑ */}
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '1px', marginBottom: '0.3rem' }}>
          {breadcrumbs(treeRoot).map((seg, i) => (
            <span key={`${seg.path || 'gap'}-${i}`} style={{ display: 'inline-flex', alignItems: 'center' }}>
              {i > 0 && <span style={{ color: T.textMuted, fontSize: '0.62rem', margin: '0 1px' }}>/</span>}
              {seg.path ? (
                <button
                  className="crumb"
                  onClick={() => goTo(seg.path)}
                  title={seg.path}
                  style={{
                    background: 'none', border: 'none', padding: '0 2px',
                    color: seg.path === treeRoot ? T.accent : T.textSecondary,
                    fontSize: '0.68rem', fontFamily: T.fontMono,
                    cursor: 'pointer', borderRadius: '3px',
                    maxWidth: '90px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                >{seg.label}</button>
              ) : (
                <span style={{ color: T.textMuted, fontSize: '0.68rem', padding: '0 2px' }}>{seg.label}</span>
              )}
            </span>
          ))}
        </div>
        {/* 路径栏：↑ 上级 / 🏠 默认工作目录 / 可编辑路径 / ▶ 就地启动。
            ▶ 直接在输入框里的目录开终端 —— 不必先回上一级再到树里找那一行。 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '0.4rem' }}>
          <button
            title="上一级目录"
            onClick={() => goTo(parentDir(treeRoot))}
            style={iconBtn(T, '0.75rem')}
          >↑</button>
          {homeDir && (
            <button
              title={`回到默认工作目录 ${homeDir}`}
              onClick={() => goTo(homeDir)}
              style={iconBtn(T)}
            >🏠</button>
          )}
          <input
            className="path-input"
            value={pathValue}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') goTo(pathValue); }}
            placeholder="输入路径后回车浏览，或点 ▶ 直接启动"
            style={{
              flex: 1, minWidth: 0, background: T.bgInput, border: `1px solid ${T.border}`,
              color: T.textPrimary, borderRadius: T.radiusSm,
              padding: '2px 6px', fontSize: '0.72rem', outline: 'none',
              fontFamily: T.fontMono, transition: 'border-color 0.15s',
            }}
          />
          <LaunchMenu path={pathValue.trim()} onLaunch={launchWithMachine} T={T} />
        </div>
        <DirTree
          ws={ws}
          machineId={machineId}
          rootPath={treeRoot}
          onLaunch={launchWithMachine}
          onPreviewMd={onPreviewMd}
          onNavigate={goTo}
        />
      </div>
    </div>
  );
}
