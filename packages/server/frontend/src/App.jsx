import { useState } from 'react';
import Login from './Login';
import Register from './Register';
import Dashboard from './Dashboard';
import { ThemeContext, getTheme } from './theme';
import { useSessionRefresh } from './session-refresh';

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [page, setPage]   = useState('login');
  const [isDark, setIsDark] = useState(
    localStorage.getItem('theme') !== 'light'
  );

  function toggleTheme() {
    const next = !isDark;
    setIsDark(next);
    localStorage.setItem('theme', next ? 'dark' : 'light');
  }

  function handleLogin(t) {
    localStorage.setItem('token', t);
    setToken(t);
  }

  function handleLogout() {
    localStorage.removeItem('token');
    setToken(null);
    setPage('login');
  }

  // 续期换到的新票和登录拿到的票落地方式相同（写 localStorage + 置状态），所以复用 handleLogin。
  const refreshSession = useSessionRefresh(token, handleLogin, handleLogout);

  const theme = getTheme(isDark);

  return (
    <ThemeContext.Provider value={theme}>
      {token
        ? <Dashboard token={token} onLogout={handleLogout} onAuthFailed={refreshSession} onTokenRenewed={handleLogin} isDark={isDark} onToggleTheme={toggleTheme} />
        : page === 'register'
          ? <Register onLogin={handleLogin} onBack={() => setPage('login')} />
          : <Login onLogin={handleLogin} onRegister={() => setPage('register')} isDark={isDark} onToggleTheme={toggleTheme} />
      }
    </ThemeContext.Provider>
  );
}
