import { createContext, useContext } from 'react';

const BASE = {
  accent:       '#6366f1',
  accentHover:  '#818cf8',
  accentDim:    'rgba(99,102,241,0.15)',
  borderAccent: 'rgba(99,102,241,0.4)',
  success:      '#10b981',
  successDim:   'rgba(16,185,129,0.15)',
  danger:       '#ef4444',
  dangerDim:    'rgba(239,68,68,0.15)',
  warning:      '#f59e0b',
  radiusSm:     '6px',
  radiusMd:     '8px',
  radiusLg:     '12px',
  radiusPill:   '9999px',
  fontSans:     '"Plus Jakarta Sans", system-ui, sans-serif',
  fontMono:     '"JetBrains Mono", monospace',
};

export const DARK = {
  ...BASE,
  bgBase:        '#0a0a0f',
  bgPanel:       '#0f0f17',
  bgCard:        '#16161f',
  bgHover:       '#1e1e2e',
  bgInput:       '#0d0d14',
  border:        'rgba(255,255,255,0.07)',
  borderHover:   'rgba(255,255,255,0.14)',
  textPrimary:   '#f1f5f9',
  textSecondary: '#94a3b8',
  textMuted:     '#475569',
};

export const LIGHT = {
  ...BASE,
  bgBase:        '#f4f4f5',
  bgPanel:       '#ffffff',
  bgCard:        '#ffffff',
  bgHover:       '#f0f0f2',
  bgInput:       '#f9f9fb',
  border:        'rgba(0,0,0,0.08)',
  borderHover:   'rgba(0,0,0,0.15)',
  textPrimary:   '#111118',
  textSecondary: '#4b5563',
  textMuted:     '#9ca3af',
};

export const getTheme = (isDark) => isDark ? DARK : LIGHT;

// 向后兼容
export const T = DARK;

// React Context
export const ThemeContext = createContext(DARK);
export const useTheme = () => useContext(ThemeContext);

export const makeInputBase = (T) => ({
  display: 'block',
  width: '100%',
  padding: '0.55rem 0.85rem',
  borderRadius: T.radiusSm,
  border: `1px solid ${T.border}`,
  background: T.bgInput,
  color: T.textPrimary,
  boxSizing: 'border-box',
  outline: 'none',
  fontSize: '0.875rem',
  fontFamily: T.fontSans,
  transition: 'border-color 0.15s',
});

// 向后兼容
export const inputBase = makeInputBase(DARK);
