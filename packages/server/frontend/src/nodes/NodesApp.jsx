import { useCallback, useEffect, useRef, useState } from 'react';
import { ThemeContext, getTheme } from '../theme';
import { getRunningSessionCommand, getRunningSessionTitle } from '../session-list-utils';
import { connectNode, EMPTY_NODE, loginNode } from './node-connection';
import { exportNodes, importNodes, loadNodes, NODES_KEY, normalizeNodeUrl, sessionKey } from './node-store';
import './nodes.css';

import TerminalPanel from '../TerminalPanel';
const STATUS = { online: '已连接', connecting: '连接中', offline: '已离线', auth: '待登录' };
const lastSeenLabel = time => time ? new Date(time).toLocaleString() : '尚未收到数据';

function NodeCard({ node, onUpdate, onRemove, onSnapshot }) {
  const [snapshot, setSnapshot] = useState(EMPTY_NODE);
  const [loginError, setLoginError] = useState('');
  const [busy, setBusy] = useState(false);
  const connection = useRef(null);
  const loginRequest = useRef(null);
  const tokenRef = useRef(node.token);
  const loggedIn = Boolean(node.token);
  useEffect(() => { tokenRef.current = node.token; connection.current?.setToken(node.token); }, [node.token]);
  useEffect(() => {
    if (!loggedIn) return;
    const controller = connectNode({
      url: node.url, token: tokenRef.current, onChange: setSnapshot,
      onToken: token => onUpdate(node.url, { token }),
      onExpired: () => onUpdate(node.url, { token: '' }),
    });
    connection.current = controller;
    return () => { controller.dispose(); connection.current = null; };
  }, [node.url, loggedIn, onUpdate]);
  const current = loggedIn ? snapshot : EMPTY_NODE;
  useEffect(() => { onSnapshot(node.url, current); }, [node.url, current, onSnapshot]);
  useEffect(() => () => loginRequest.current?.abort(), []);

  async function login(event) {
    event.preventDefault();
    setBusy(true);
    setLoginError('');
    const form = new FormData(event.currentTarget);
    const controller = new AbortController();
    loginRequest.current = controller;
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const result = await loginNode(node.url, form.get('username'), form.get('password'), controller.signal);
      if (!controller.signal.aborted) onUpdate(node.url, { token: result.token, username: result.username });
    } catch (error) {
      setLoginError(error.name === 'AbortError' ? '连接超时，请检查节点是否可达' :
        error instanceof TypeError ? '无法连接，请检查节点地址，以及节点是否允许此看板来源' : error.message);
    } finally { clearTimeout(timer); setBusy(false); }
  }

  return <article className="node-card" data-status={current.status}>
    <div className="node-card-heading"><strong>{node.name}</strong><span className={`node-status ${current.status}`}><i />{STATUS[current.status]}</span></div>
    <a className="node-address" href={`${node.url}/`} target="_blank" rel="noreferrer">{node.url} ↗</a>
    {loggedIn ? <>
      <p className="node-card-meta">{current.username || node.username || '验证身份中'} · {current.machines.length} 台机器 · {current.sessions.length} 个会话</p>
      {current.status !== 'online' && <p className="node-card-meta">最后更新：{lastSeenLabel(current.lastSeen)}</p>}
      {current.error && <p className="node-error" role="status">{current.error}</p>}
      {current.role === 'admin' && <label className="node-scope"><input type="checkbox" checked={current.ownOnly === false}
        disabled={current.status !== 'online'} onChange={e => connection.current?.setOwnOnly(!e.target.checked)} />查看所有用户</label>}
    </> : <form className="node-login" onSubmit={login}>
      <label>用户名<input name="username" autoComplete="username" defaultValue={node.username} required aria-label={`${node.name}用户名`} /></label>
      <label>密码<input name="password" type="password" autoComplete="current-password" required aria-label={`${node.name}密码`} /></label>
      <button className="node-primary" disabled={busy}>{busy ? '正在登录…' : '登录此节点'}</button>
      {(loginError || snapshot.error) && <p className="node-error" role="alert">{loginError || snapshot.error}</p>}
    </form>}
    <div className="node-card-actions">
      {loggedIn && <button onClick={() => onUpdate(node.url, { token: '' })}>退出此节点</button>}
      <button onClick={() => onRemove(node.url)}>移除</button>
    </div>
  </article>;
}

function AddNode({ nodes, onAdd, onClose }) {
  const [error, setError] = useState('');
  function submit(event) {
    event.preventDefault();
    try {
      const form = new FormData(event.currentTarget);
      const url = normalizeNodeUrl(form.get('url'));
      if (location.protocol === 'https:' && url.startsWith('http:')) throw new Error('HTTPS 看板需要连接 HTTPS 节点，请填写节点的 HTTPS 地址');
      if (nodes.some(n => n.url === url)) throw new Error('该节点已在列表中');
      onAdd({ url, name: form.get('name').trim() || new URL(url).host, token: '', username: '' });
      onClose();
    } catch (e) { setError(e.message); }
  }
  return <div className="nodes-overlay" onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
    <section className="nodes-dialog" role="dialog" aria-modal="true" aria-labelledby="add-node-title">
      <div className="nodes-dialog-title"><h2 id="add-node-title">添加节点</h2><button aria-label="关闭添加节点" onClick={onClose}>×</button></div>
      <p>填入独立 VibeAnything 服务的地址，随后使用该节点的账号登录。</p>
      <form onSubmit={submit}>
        <label>节点名称<input name="name" placeholder="例如：工作站" autoFocus /></label>
        <label>节点地址<input name="url" type="url" required placeholder="http://node-a:3000" /></label>
        <p className="node-hint">跨站连接时，在目标节点的 DASHBOARD_ORIGINS 中加入 <code>{location.origin}</code> 并重启服务。</p>
        {error && <p className="node-error" role="alert">{error}</p>}
        <button className="node-primary" type="submit">添加节点</button>
      </form>
    </section>
  </div>;
}

export default function NodesApp() {
  const [nodes, setNodes] = useState(loadNodes);
  const [snapshots, setSnapshots] = useState({});
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [selectedNode, setSelectedNode] = useState('');
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(false);
  const [showNodes, setShowNodes] = useState(() => !nodes.some(n => n.token));
  const [notice, setNotice] = useState('');
  const [dark, setDark] = useState(() => localStorage.getItem('theme') !== 'light');
  const importRef = useRef(null);
  useEffect(() => { localStorage.setItem(NODES_KEY, JSON.stringify(nodes)); }, [nodes]);
  const updateNode = useCallback((url, patch) => {
    setNodes(prev => prev.map(node => node.url === url ? { ...node, ...patch } : node));
    // 同源节点沿用现有登录；远程节点的凭据始终留在它自己的条目里。
    if (url === location.origin && 'token' in patch) {
      if (patch.token) localStorage.setItem('token', patch.token);
      else localStorage.removeItem('token');
    }
  }, []);
  useEffect(() => {
    const onStorage = event => {
      if (event.key === 'token') updateNode(location.origin, { token: event.newValue || '' });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [updateNode]);
  const onSnapshot = useCallback((url, snapshot) => setSnapshots(prev => ({ ...prev, [url]: snapshot })), []);
  function removeNode(url) {
    setNodes(prev => prev.filter(node => node.url !== url));
    setSnapshots(prev => { const next = { ...prev }; delete next[url]; return next; });
    if (selectedNode === url) setSelectedNode('');
    if (selected?.url === url) setSelected(null);
  }
  const online = nodes.filter(n => snapshots[n.url]?.status === 'online').length;
  const allSessions = nodes.flatMap(node => {
    const snapshot = snapshots[node.url] || EMPTY_NODE;
    return snapshot.sessions.map(session => ({ ...session, node, snapshot, key: sessionKey(node.url, session) }));
  });
  const running = allSessions.filter(s => s.snapshot.status === 'online' && s.isRunning).length;
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visible = allSessions.filter(s => {
    if (selectedNode && s.node.url !== selectedNode) return false;
    if (filter === 'running' && (s.snapshot.status !== 'online' || !s.isRunning)) return false;
    if (filter === 'idle' && (s.snapshot.status !== 'online' || s.isRunning)) return false;
    if (filter === 'offline' && s.snapshot.status === 'online') return false;
    const text = [s.node.name, s.node.url, s.machineId, s.sessionId, s.cwd, s.tool, s.owner, s.sharedBy, s.snapshot.username].join(' ').toLowerCase();
    return words.every(word => text.includes(word));
  });
  const groups = new Map();
  for (const session of visible) {
    const owner = 'owner' in session ? (session.owner || '未归属') : (session.sharedBy || session.snapshot.username || '未归属');
    const key = JSON.stringify([session.node.url, owner]);
    if (!groups.has(key)) groups.set(key, { node: session.node, owner, sessions: [] });
    groups.get(key).sessions.push(session);
  }
  const active = selected && allSessions.find(s => s.key === selected.key);
  const activeAllowed = active && active.snapshot.status === 'online' &&
    !(active.snapshot.deniedSession === active.sessionId && active.snapshot.deniedMachine === active.machineId);

  function downloadNodes() {
    const url = URL.createObjectURL(new Blob([exportNodes(nodes)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = 'vibeanything-nodes.json'; anchor.click();
    URL.revokeObjectURL(url);
    setNotice('已导出节点名称和地址。登录凭据留在当前浏览器中。');
  }
  async function readImport(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const incoming = importNodes(await file.text());
      if (location.protocol === 'https:' && incoming.some(n => n.url.startsWith('http:'))) throw new Error('HTTPS 看板需要连接 HTTPS 节点');
      setNodes(prev => {
        const next = [...prev];
        for (const node of incoming) if (!next.some(n => n.url === node.url)) next.push(node);
        return next;
      });
      setNotice('节点配置已导入，请在新节点上登录。');
    } catch (e) { setNotice(`导入失败：${e.message}`); }
  }

  return <ThemeContext.Provider value={getTheme(dark)}>
    <div className="nodes-app" data-theme={dark ? 'dark' : 'light'}>
      <header className="nodes-topbar">
        <a className="nodes-brand" href="/">V<span>✳</span> <span>VibeAnything</span></a>
        <span className="nodes-top-label">多节点工作台</span>
        <div className="nodes-top-actions"><a href="/">单节点看板 ↗</a><button onClick={() => { setDark(!dark); localStorage.setItem('theme', dark ? 'light' : 'dark'); }} aria-label="切换主题">{dark ? '☼' : '☾'}</button></div>
      </header>
      <button className="nodes-mobile-toggle" aria-expanded={showNodes} onClick={() => setShowNodes(!showNodes)}>◎ 节点管理 · {online}/{nodes.length} 在线 <span>{showNodes ? '收起 ↑' : '展开 ↓'}</span></button>
      <div className="nodes-layout">
        <aside className="nodes-sidebar" data-expanded={showNodes}>
          <div className="nodes-sidebar-title"><h2>我的节点 <span>{nodes.length}</span></h2><button className="node-add" onClick={() => setAdding(true)} aria-label="添加节点">＋</button></div>
          <p className="nodes-sidebar-description">分别连接，独立运行。</p>
          <div className="nodes-card-list">{nodes.map(node => <NodeCard key={node.url} node={node} onUpdate={updateNode} onRemove={removeNode} onSnapshot={onSnapshot} />)}</div>
          {!nodes.length && <p className="node-hint">添加一个节点，开始汇总会话。</p>}
          <div className="nodes-portability"><button onClick={downloadNodes}>导出节点</button><button onClick={() => importRef.current?.click()}>导入节点</button>
            <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={readImport} /></div>
          <p className="node-hint">节点配置保存在此浏览器。换一个入口时，可导入地址并重新登录。</p>
        </aside>
        <main className="nodes-main">
          <div className="nodes-intro"><div><span className="nodes-eyebrow">你的工作，分布各处。</span><h1>在这里，一起看见。</h1><p>跨节点查看会话，随时接回正在进行的工作。</p></div><span className="nodes-live"><i />{online} / {nodes.length} 节点在线</span></div>
          <div className="nodes-stats"><div><span>在线节点</span><strong>{online.toString().padStart(2, '0')}</strong></div><div><span>在线会话</span><strong>{allSessions.filter(s => s.snapshot.status === 'online').length.toString().padStart(2, '0')}</strong></div><div><span>正在运行</span><strong>{running.toString().padStart(2, '0')}</strong></div><div><span>未连接节点</span><strong>{(nodes.length - online).toString().padStart(2, '0')}</strong></div></div>
          {notice && <div className="nodes-notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="关闭提示">×</button></div>}
          <div className="nodes-tools"><label className="nodes-search"><span>⌕</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索会话、目录、机器或用户…" aria-label="搜索会话" /></label>
            <select value={selectedNode} onChange={e => setSelectedNode(e.target.value)} aria-label="筛选节点"><option value="">所有节点</option>{nodes.map(n => <option key={n.url} value={n.url}>{n.name}</option>)}</select></div>
          <div className="nodes-filters" aria-label="会话状态">{[['all', '全部会话'], ['running', '运行中'], ['idle', '空闲'], ['offline', '离线快照']].map(([key, label]) => <button key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}<span>{visible.length} 个会话</span></div>
          <div className="nodes-session-groups">{[...groups.entries()].map(([key, group]) => <section className="nodes-session-group" key={key}>
            <h2><span>{group.node.name}</span><span className="nodes-group-owner">/ {group.owner}</span><small>{group.sessions.length}</small></h2>
            <div className="nodes-session-grid">{group.sessions.map(s => {
              const stale = s.snapshot.status !== 'online';
              return <button className="nodes-session" key={s.key} disabled={stale} onClick={() => setSelected({ key: s.key, url: s.node.url, title: getRunningSessionTitle(s) })}>
                <div className="nodes-session-heading"><span className="nodes-tool">{s.tool || 'shell'}</span><span className={`nodes-session-state ${stale ? 'stale' : s.isRunning ? 'running' : 'idle'}`}><i />{stale ? '状态未知' : s.isRunning ? '运行中' : '空闲'}</span></div>
                <h3>{getRunningSessionTitle(s)}</h3><p title={s.cwd}>{s.cwd || s.sessionId}</p>
                <div className="nodes-session-footer"><span>{s.machineId}{s.sharedBy ? ' · 共享' : ''}</span><span>{stale ? '最后更新 ' + lastSeenLabel(s.snapshot.lastSeen) : '打开终端 ↗'}</span></div>
              </button>;
            })}</div>
          </section>)}</div>
          {!visible.length && <div className="nodes-empty"><span>⌘</span><h2>{allSessions.length ? '没有匹配的会话' : '等待你的第一个会话'}</h2><p>{allSessions.length ? '换一个关键词或状态筛选试试。' : '登录节点后，这里会显示你有权访问的在线会话。'}</p>{!nodes.length && <button className="node-primary" onClick={() => setAdding(true)}>添加节点</button>}</div>}
        </main>
      </div>
      {adding && <AddNode nodes={nodes} onAdd={node => setNodes(prev => [...prev, node])} onClose={() => setAdding(false)} />}
      {selected && <section className="nodes-terminal" role="dialog" aria-modal="true" aria-label="节点终端">
        <header><div><strong>{selected.title}</strong><span>{active?.node.name || selected.url} / {active?.machineId || ''}</span></div><button onClick={() => setSelected(null)} aria-label="关闭终端">关闭 ×</button></header>
        {activeAllowed ? <TerminalPanel key={active.key} ws={active.snapshot.ws} machineId={active.machineId} sessionId={active.sessionId} command={getRunningSessionCommand(active)} cwd={active.cwd} />
          : <div className="nodes-empty"><h2>此会话暂时不可用</h2><p>{active?.snapshot.error || '节点已断开、会话已结束或访问权限已变更。可关闭窗口继续查看其他节点。'}</p></div>}
      </section>}
    </div>
  </ThemeContext.Provider>;
}
