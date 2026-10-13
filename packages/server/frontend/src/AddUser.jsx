import { useState } from 'react';
import { useTheme, makeInputBase } from './theme';

export default function AddUser({ token, onClose }) {
  const T = useTheme();
  const inputBase = makeInputBase(T);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [success, setSuccess]   = useState('');
  const [loading, setLoading]   = useState(false);
  const [focused, setFocused]   = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError(''); setSuccess('');
    setLoading(true);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (res.ok) {
        setSuccess(`用户 "${data.username}" 创建成功`);
        setUsername(''); setPassword('');
      } else {
        setError(data.error || '创建失败');
      }
    } catch {
      setError('连接失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      onClick={e => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.7)',
        backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 100, fontFamily: T.fontSans,
        animation: 'fadeIn 0.15s ease',
      }}
    >
      <style>{`
        @keyframes fadeIn { from{opacity:0} to{opacity:1} }
        @keyframes slideUp { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
        .modal-input:focus { border-color: ${T.borderAccent} !important; box-shadow: 0 0 0 3px ${T.accentDim}; }
        .modal-submit:hover:not(:disabled) { background: ${T.accentHover} !important; }
        .modal-cancel:hover { background: ${T.bgHover} !important; color: ${T.textPrimary} !important; }
      `}</style>

      <div style={{
        background: T.bgCard,
        border: `1px solid ${T.border}`,
        borderRadius: T.radiusLg,
        padding: '1.75rem',
        width: '100%', maxWidth: '340px',
        boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        animation: 'slideUp 0.2s ease',
      }}>
        {/* 标题 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
          <div>
            <div style={{ color: T.textPrimary, fontWeight: 600, fontSize: '0.95rem' }}>添加用户</div>
            <div style={{ color: T.textMuted, fontSize: '0.75rem', marginTop: '2px' }}>创建新的登录账号</div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: T.bgHover, border: `1px solid ${T.border}`,
              color: T.textMuted, borderRadius: '6px',
              cursor: 'pointer', width: '28px', height: '28px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.85rem',
            }}
          >✕</button>
        </div>

        {/* 消息 */}
        {error && (
          <div style={{
            background: T.dangerDim, border: '1px solid rgba(239,68,68,0.25)',
            borderRadius: T.radiusSm, padding: '0.5rem 0.75rem',
            color: '#fca5a5', fontSize: '0.82rem', marginBottom: '1rem',
          }}>{error}</div>
        )}
        {success && (
          <div style={{
            background: T.successDim, border: '1px solid rgba(16,185,129,0.25)',
            borderRadius: T.radiusSm, padding: '0.5rem 0.75rem',
            color: '#6ee7b7', fontSize: '0.82rem', marginBottom: '1rem',
          }}>{success}</div>
        )}

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '0.75rem' }}>
            <label style={{ display: 'block', color: T.textSecondary, fontSize: '0.75rem', marginBottom: '0.3rem', fontWeight: 500 }}>用户名</label>
            <input
              className="modal-input"
              placeholder="输入用户名"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoFocus
              style={{ ...inputBase, border: `1px solid ${focused === 'u' ? T.borderAccent : T.border}` }}
              onFocus={() => setFocused('u')}
              onBlur={() => setFocused('')}
            />
          </div>
          <div style={{ marginBottom: '1.25rem' }}>
            <label style={{ display: 'block', color: T.textSecondary, fontSize: '0.75rem', marginBottom: '0.3rem', fontWeight: 500 }}>密码</label>
            <input
              className="modal-input"
              type="password"
              placeholder="至少 6 个字符"
              value={password}
              onChange={e => setPassword(e.target.value)}
              style={{ ...inputBase, border: `1px solid ${focused === 'p' ? T.borderAccent : T.border}` }}
              onFocus={() => setFocused('p')}
              onBlur={() => setFocused('')}
            />
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              className="modal-submit"
              type="submit"
              disabled={loading}
              style={{
                flex: 1, padding: '0.55rem',
                background: loading ? T.bgHover : T.accent,
                color: '#fff', border: 'none',
                borderRadius: T.radiusSm, cursor: loading ? 'not-allowed' : 'pointer',
                fontSize: '0.85rem', fontWeight: 600, fontFamily: T.fontSans,
                opacity: loading ? 0.7 : 1, transition: 'background 0.15s',
              }}
            >
              {loading ? '创建中…' : '创建用户'}
            </button>
            <button
              className="modal-cancel"
              type="button"
              onClick={onClose}
              style={{
                flex: 1, padding: '0.55rem',
                background: 'none', color: T.textMuted,
                border: `1px solid ${T.border}`,
                borderRadius: T.radiusSm, cursor: 'pointer',
                fontSize: '0.85rem', fontFamily: T.fontSans,
                transition: 'all 0.15s',
              }}
            >取消</button>
          </div>
        </form>
      </div>
    </div>
  );
}
