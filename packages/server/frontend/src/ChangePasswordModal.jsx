import { useState } from 'react';
import { useTheme, makeInputBase } from './theme';

export default function ChangePasswordModal({ onClose, onSuccess }) {
  const T = useTheme();
  const inputBase = makeInputBase(T);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (newPassword.length < 6) {
      setError('新密码至少6个字符');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致');
      return;
    }

    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ oldPassword, newPassword })
      });

      if (res.ok) {
        onSuccess();
      } else {
        const { error: msg } = await res.json();
        setError(msg || '修改失败');
      }
    } catch {
      setError('连接服务器失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.5)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 1000
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: T.bgCard, border: `1px solid ${T.border}`,
        borderRadius: T.radiusLg, padding: '1.5rem',
        width: '100%', maxWidth: '400px',
        boxShadow: '0 24px 64px rgba(0,0,0,0.5)'
      }}>
        <h3 style={{ margin: '0 0 1rem 0', color: T.textPrimary, fontSize: '1.1rem' }}>
          修改密码
        </h3>

        {error && (
          <div style={{
            background: T.dangerDim, border: `1px solid rgba(239,68,68,0.25)`,
            borderRadius: T.radiusSm, padding: '0.5rem 0.75rem',
            color: '#fca5a5', fontSize: '0.82rem', marginBottom: '1rem'
          }}>{error}</div>
        )}

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '0.75rem' }}>
            <label style={{ display: 'block', color: T.textSecondary, fontSize: '0.8rem', marginBottom: '0.35rem' }}>
              旧密码
            </label>
            <input
              type="password"
              name="old-password"
              autoComplete="current-password"
              value={oldPassword}
              onChange={e => setOldPassword(e.target.value)}
              style={inputBase}
              autoFocus
            />
          </div>

          <div style={{ marginBottom: '0.75rem' }}>
            <label style={{ display: 'block', color: T.textSecondary, fontSize: '0.8rem', marginBottom: '0.35rem' }}>
              新密码
            </label>
            <input
              type="password"
              name="new-password"
              autoComplete="new-password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              style={inputBase}
            />
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', color: T.textSecondary, fontSize: '0.8rem', marginBottom: '0.35rem' }}>
              确认新密码
            </label>
            <input
              type="password"
              name="confirm-password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              style={inputBase}
            />
          </div>

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                flex: 1, padding: '0.5rem',
                background: T.bgHover, color: T.textPrimary,
                border: `1px solid ${T.border}`, borderRadius: T.radiusSm,
                cursor: 'pointer', fontSize: '0.875rem'
              }}
            >
              取消
            </button>
            <button
              type="submit"
              disabled={loading}
              style={{
                flex: 1, padding: '0.5rem',
                background: loading ? T.bgHover : T.accent,
                color: '#fff', border: 'none', borderRadius: T.radiusSm,
                cursor: loading ? 'not-allowed' : 'pointer',
                fontSize: '0.875rem', fontWeight: 600,
                opacity: loading ? 0.7 : 1
              }}
            >
              {loading ? '修改中...' : '确认修改'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
