import { useState } from 'react';
import Login from './Login';
import Register from './Register';
import Dashboard from './Dashboard';
import { ThemeContext, getTheme } from './theme';

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

  const theme = getTheme(isDark);

  return (
    <ThemeContext.Provider value={theme}>
      {token
        ? <Dashboard token={token} onLogout={handleLogout} isDark={isDark} onToggleTheme={toggleTheme} />
        : page === 'register'
          ? <Register onLogin={handleLogin} onBack={() => setPage('login')} />
          : <Login onLogin={handleLogin} onRegister={() => setPage('register')} isDark={isDark} onToggleTheme={toggleTheme} />
      }
    </ThemeContext.Provider>
  );
}
