import { useEffect, useRef, useState } from 'react';
import { useTheme, makeInputBase } from './theme';
import { getRunningSessionTitle } from './session-list-utils';

export default function SessionSharing({ token, session, onClose }) {
  const T = useTheme();
  const [state, setState] = useState(null);
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const closeButton = useRef(null);
  const { machineId, sessionId } = session;

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/session-shares?${new URLSearchParams({ machineId, sessionId })}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(async res => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '读取共享名单失败');
      if (!cancelled) setState(data);
    }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [token, machineId, sessionId]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    closeButton.current?.focus();
    return () => previousFocus?.focus();
  }, []);

  useEffect(() => {
    const keydown = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [onClose]);

  async function update(method, recipient) {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/session-shares', {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ machineId, sessionId, username: recipient }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '更新共享失败');
      setState(prev => ({ ...prev, ...data }));
      setUsername('');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const available = (state?.availableUsers || []).filter(u => u !== state.owner && !state.users.includes(u));
  const buttonStyle = { minHeight: 40, padding: '6px 12px', background: T.bgHover, color: T.textPrimary, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, cursor: 'pointer' };

  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-labelledby="session-sharing-title" style={{ width: '100%', maxWidth: 420, maxHeight: '85dvh', overflowY: 'auto', padding: 20, background: T.bgCard, color: T.textPrimary, border: `1px solid ${T.border}`, borderRadius: T.radiusLg, fontFamily: T.fontSans }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <h2 id="session-sharing-title" style={{ fontSize: '1rem', margin: 0 }}>共享窗口</h2>
          <button ref={closeButton} type="button" aria-label="关闭共享设置" onClick={onClose} style={buttonStyle}>✕</button>
        </div>
        <p style={{ overflowWrap: 'anywhere' }}>{getRunningSessionTitle(session)}</p>
        <p style={{ color: T.textMuted, fontSize: '0.82rem' }}>共享用户可以查看并操作这个终端。窗口仍归原所有者，共享设置由所有者或管理员管理。</p>
        {error && <p role="alert" style={{ color: T.danger }}>{error}</p>}
        {!state && !error && <p role="status">正在读取…</p>}
        {state && <>
          {state.users.length === 0 ? <p style={{ color: T.textMuted }}>尚未共享给其他用户</p> : (
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {state.users.map(u => <li key={u} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
                <span>{u}</span>
                <button type="button" disabled={busy} onClick={() => update('DELETE', u)} aria-label={`取消共享给 ${u}`} style={buttonStyle}>取消共享</button>
              </li>)}
            </ul>
          )}
          <form onSubmit={e => { e.preventDefault(); if (username) update('POST', username); }}>
            <label htmlFor="session-sharing-user" style={{ display: 'block', marginBottom: 8 }}>共享给</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <select id="session-sharing-user" value={username} disabled={busy} onChange={e => setUsername(e.target.value)} style={{ ...makeInputBase(T), flex: 1, minWidth: 0 }}>
                <option value="">选择用户</option>
                {available.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
              <button type="submit" disabled={busy || !username} style={buttonStyle}>共享</button>
            </div>
          </form>
        </>}
      </div>
    </div>
  );
}
