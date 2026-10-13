import { useState } from 'react';
import Login from '../Login';
import Register from '../Register';
import { ThemeContext, getTheme } from '../theme';
import MobileShell from './MobileShell';

// 手机版的根组件。登录态与主题**沿用桌面版的同一份 localStorage 键**
// （'token' / 'theme'）：同一个浏览器里在桌面版登录过，打开 /m 就不必再登一次，
// 反之亦然；退出登录也是两边同时生效。
//
// 登录页与注册页直接复用桌面版组件 —— 它们本来就是 maxWidth:360 的居中卡片，
// 在手机上是正常形态，没有另写一份的理由。

export default function MobileApp() {
  const [token, setToken] = useState(() => localStorage.getItem('token'));
  const [page, setPage] = useState('login');
  const [isDark, setIsDark] = useState(() => localStorage.getItem('theme') !== 'light');

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

  return (
    <ThemeContext.Provider value={getTheme(isDark)}>
      {token
        ? <MobileShell token={token} onLogout={handleLogout} isDark={isDark} onToggleTheme={toggleTheme} />
        : page === 'register'
          ? <Register onLogin={handleLogin} onBack={() => setPage('login')} />
          : <Login onLogin={handleLogin} onRegister={() => setPage('register')} isDark={isDark} onToggleTheme={toggleTheme} />
      }
    </ThemeContext.Provider>
  );
}
