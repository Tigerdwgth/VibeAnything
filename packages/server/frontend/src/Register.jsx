import { useState } from 'react';
import { FULL_VIEWPORT_HEIGHT } from './mobile-layout-config';

export default function Register({ onLogin, onBack }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (password !== confirm) { setError('两次密码不一致'); return; }
    if (password.length < 6) { setError('密码至少6个字符'); return; }
    setLoading(true);
    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (res.ok) {
        onLogin(data.token);
      } else {
        setError(data.error || '注册失败');
      }
    } catch {
      setError('连接服务器失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display:'flex', justifyContent:'center', alignItems:'center', height: FULL_VIEWPORT_HEIGHT, background:'#0d1117' }}>
      <form onSubmit={handleSubmit} style={{ background:'#161b22', padding:'2rem', borderRadius:'8px', minWidth:'320px', border:'1px solid #30363d' }}>
        <h2 style={{ color:'#e6edf3', marginBottom:'1.5rem', textAlign:'center', fontSize:'1.2rem' }}>注册账号</h2>
        {error && <p style={{ color:'#f85149', fontSize:'0.85rem', margin:'0 0 1rem' }}>{error}</p>}
        <input
          placeholder="用户名（至少2个字符）"
          value={username}
          onChange={e => setUsername(e.target.value)}
          autoFocus
          style={inputStyle}
        />
        <input
          type="password"
          placeholder="密码（至少6个字符）"
          value={password}
          onChange={e => setPassword(e.target.value)}
          style={inputStyle}
        />
        <input
          type="password"
          placeholder="确认密码"
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          style={inputStyle}
        />
        <button type="submit" disabled={loading} style={btnStyle(loading)}>
          {loading ? '注册中…' : '注册'}
        </button>
        <p style={{ textAlign:'center', marginTop:'1rem', fontSize:'0.82rem', color:'#8b949e' }}>
          已有账号？
          <span onClick={onBack} style={{ color:'#58a6ff', cursor:'pointer', marginLeft:'4px' }}>登录</span>
        </p>
      </form>
    </div>
  );
}

const inputStyle = {
  display:'block', width:'100%', marginBottom:'0.75rem', padding:'0.5rem 0.75rem',
  borderRadius:'6px', border:'1px solid #30363d', background:'#0d1117',
  color:'#e6edf3', boxSizing:'border-box', outline:'none'
};

const btnStyle = (loading) => ({
  width:'100%', padding:'0.5rem', background: loading ? '#21262d' : '#1f6feb',
  color:'#e6edf3', border:'1px solid #388bfd', borderRadius:'6px',
  cursor: loading ? 'not-allowed' : 'pointer', fontSize:'0.9rem'
});
