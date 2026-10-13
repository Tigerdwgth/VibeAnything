import { useEffect, useMemo, useState } from 'react';
import { useTheme } from './theme';

// 用量面板：读 /api/usage/summary，展示 Claude Code、Codex 与 OpenCode 的花费与 token。
// 数据由各开发机的 ccusage 采集器每小时上报，后端按
// (用户, 机器, agent, 日期, 模型) 幂等落库。

const AGENT_META = {
  claude: { label: 'Claude', color: '#d97757' },
  codex: { label: 'Codex', color: '#10b981' },
  opencode: { label: 'OpenCode', color: '#6366f1' },
};

const RANGES = [
  { key: '7', label: '近 7 天', days: 7 },
  { key: '30', label: '近 30 天', days: 30 },
  { key: 'all', label: '全部', days: null },
];

function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days + 1);
  return d.toISOString().slice(0, 10);
}

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

function fmtCost(n) {
  const v = Number(n) || 0;
  return v >= 1000 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`;
}

/** 把 [{key, agent, costUSD, ...}] 折叠成 { key, total, byAgent: {claude, codex, opencode} } */
function foldByAgent(rows, keyField) {
  const map = new Map();
  for (const r of rows || []) {
    const k = r[keyField];
    if (!map.has(k)) map.set(k, { key: k, total: 0, tokens: 0, byAgent: {} });
    const e = map.get(k);
    const cost = Number(r.costUSD) || 0;
    e.total += cost;
    e.tokens += Number(r.totalTokens) || 0;
    e.byAgent[r.agent] = (e.byAgent[r.agent] || 0) + cost;
  }
  return [...map.values()];
}

function StatCard({ T, label, value, sub, accent }) {
  return (
    <div style={{
      flex: '1 1 140px', minWidth: 0, padding: '0.75rem 0.9rem',
      background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: T.radiusMd,
    }}>
      <div style={{
        fontSize: '0.66rem', color: T.textMuted, textTransform: 'uppercase',
        letterSpacing: '0.06em', fontWeight: 600, marginBottom: '0.35rem',
      }}>{label}</div>
      <div style={{
        fontSize: '1.35rem', fontWeight: 700, fontFamily: T.fontMono,
        color: accent || T.textPrimary, lineHeight: 1.1,
      }}>{value}</div>
      {sub && <div style={{ fontSize: '0.7rem', color: T.textSecondary, marginTop: '0.25rem' }}>{sub}</div>}
    </div>
  );
}

/** 一行「标签 + 双色堆叠条 + 金额」。max 传 0 时不画条，避免除零。 */
function StackedBar({ T, label, row, max, showTokens }) {
  return (
    <div style={{ marginBottom: '0.55rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.25rem' }}>
        <span style={{
          flex: 1, minWidth: 0, fontSize: '0.78rem', color: T.textPrimary,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{label}</span>
        {showTokens && (
          <span style={{ fontSize: '0.68rem', color: T.textMuted, fontFamily: T.fontMono }}>
            {fmtTokens(row.tokens)} tok
          </span>
        )}
        <span style={{ fontSize: '0.78rem', color: T.textPrimary, fontFamily: T.fontMono, fontWeight: 600 }}>
          {fmtCost(row.total)}
        </span>
      </div>
      <div style={{
        display: 'flex', height: '6px', borderRadius: T.radiusPill,
        background: T.bgHover, overflow: 'hidden',
      }}>
        {Object.entries(AGENT_META).map(([agent, meta]) => {
          const v = row.byAgent[agent] || 0;
          const pct = max > 0 ? (v / max) * 100 : 0;
          if (pct <= 0) return null;
          return <div key={agent} title={`${meta.label} ${fmtCost(v)}`}
            style={{ width: `${pct}%`, background: meta.color }} />;
        })}
      </div>
    </div>
  );
}

function Section({ T, title, extra, children }) {
  return (
    <div style={{
      background: T.bgCard, border: `1px solid ${T.border}`,
      borderRadius: T.radiusMd, padding: '0.9rem 1rem', marginBottom: '0.85rem',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '0.7rem' }}>
        <span style={{
          flex: 1, fontSize: '0.7rem', fontWeight: 700, color: T.textSecondary,
          textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>{title}</span>
        {extra}
      </div>
      {children}
    </div>
  );
}

export default function UsagePanel({ token, isAdmin, selfUsername }) {
  const T = useTheme();
  const [range, setRange] = useState('30');
  const [scopeAll, setScopeAll] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const days = RANGES.find(r => r.key === range)?.days;
        const qs = new URLSearchParams();
        if (days) qs.set('since', isoDaysAgo(days));
        // 管理员默认看全员；关掉「全员」时按 whoami 下发的用户名过滤成自己。
        // 非管理员不用传，后端会强制限定，传了也越不了权。
        if (isAdmin && !scopeAll && selfUsername) qs.set('username', selfUsername);
        const res = await fetch(`/api/usage/summary?${qs}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        const json = await res.json();
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [token, range, scopeAll, isAdmin, selfUsername]);

  const users = useMemo(() => foldByAgent(data?.byUser, 'username').sort((a, b) => b.total - a.total), [data]);
  const dates = useMemo(() => foldByAgent(data?.byDate, 'date').sort((a, b) => a.key.localeCompare(b.key)), [data]);
  const models = useMemo(() => foldByAgent(data?.byModel, 'model').sort((a, b) => b.total - a.total), [data]);

  const totals = data?.totals || {};
  const agentCost = useMemo(() => {
    const out = { claude: 0, codex: 0, opencode: 0 };
    for (const r of data?.byUser || []) out[r.agent] = (out[r.agent] || 0) + (Number(r.costUSD) || 0);
    return out;
  }, [data]);

  const maxUser = Math.max(0, ...users.map(u => u.total));
  const maxDate = Math.max(0, ...dates.map(d => d.total));
  const maxModel = Math.max(0, ...models.map(m => m.total));

  const pill = (activeFlag) => ({
    background: activeFlag ? T.bgHover : 'none',
    border: `1px solid ${activeFlag ? T.border : 'transparent'}`,
    color: activeFlag ? T.textPrimary : T.textMuted,
    borderRadius: T.radiusPill, cursor: 'pointer',
    padding: '3px 12px', fontSize: '0.72rem', fontWeight: 500,
    fontFamily: T.fontSans, transition: 'all 0.15s',
  });

  return (
    <div style={{
      flex: 1, overflow: 'auto', padding: '1rem 1.25rem',
      background: T.bgBase, color: T.textPrimary, fontFamily: T.fontSans,
    }}>
      {/* 工具栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '0.9rem', flexWrap: 'wrap' }}>
        {RANGES.map(r => (
          <button key={r.key} onClick={() => setRange(r.key)} style={pill(range === r.key)}>{r.label}</button>
        ))}
        <div style={{ flex: 1 }} />
        {isAdmin && (
          <button onClick={() => setScopeAll(v => !v)} style={pill(scopeAll)}
            title={scopeAll ? '当前：全员用量' : '当前：只看自己'}>
            {scopeAll ? '👥 全员' : '👤 仅我'}
          </button>
        )}
        {loading && <span style={{ fontSize: '0.7rem', color: T.textMuted }}>加载中…</span>}
      </div>

      {error && (
        <div style={{
          padding: '0.7rem 0.9rem', marginBottom: '0.85rem',
          background: T.dangerDim, border: `1px solid ${T.danger}`,
          borderRadius: T.radiusMd, fontSize: '0.78rem', color: T.textPrimary,
        }}>加载失败：{error}</div>
      )}

      {/* 总计 */}
      <div style={{ display: 'flex', gap: '0.6rem', marginBottom: '0.85rem', flexWrap: 'wrap' }}>
        <StatCard T={T} label="总花费" value={fmtCost(totals.costUSD)}
          sub={`${users.length} 位用户 · ${dates.length} 天`} />
        <StatCard T={T} label="Claude" value={fmtCost(agentCost.claude)} accent={AGENT_META.claude.color} />
        <StatCard T={T} label="Codex" value={fmtCost(agentCost.codex)} accent={AGENT_META.codex.color} />
        <StatCard T={T} label="OpenCode" value={fmtCost(agentCost.opencode)} accent={AGENT_META.opencode.color} />
        <StatCard T={T} label="总 Token" value={fmtTokens(totals.totalTokens)}
          sub={`输出 ${fmtTokens(totals.outputTokens)} · 缓存读 ${fmtTokens(totals.cacheReadTokens)}`} />
      </div>

      {!loading && !error && !users.length && (
        <div style={{
          padding: '2rem', textAlign: 'center', color: T.textMuted, fontSize: '0.8rem',
          background: T.bgCard, border: `1px dashed ${T.border}`, borderRadius: T.radiusMd,
        }}>
          还没有用量数据。在开发机上跑 <code style={{ fontFamily: T.fontMono, color: T.textSecondary }}>vibeanything --usage-report</code> 上报一次。
        </div>
      )}

      {!!users.length && (
        <Section T={T} title="按用户" extra={
          <span style={{ display: 'flex', gap: '0.6rem', fontSize: '0.66rem', color: T.textMuted }}>
            {Object.entries(AGENT_META).map(([k, m]) => (
              <span key={k} style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '2px', background: m.color }} />
                {m.label}
              </span>
            ))}
          </span>
        }>
          {users.map(u => <StackedBar key={u.key} T={T} label={u.key} row={u} max={maxUser} showTokens />)}
        </Section>
      )}

      {!!dates.length && (
        <Section T={T} title="每日走势">
          {dates.map(d => <StackedBar key={d.key} T={T} label={d.key} row={d} max={maxDate} />)}
        </Section>
      )}

      {!!models.length && (
        <Section T={T} title="按模型">
          {models.map(m => <StackedBar key={m.key} T={T} label={m.key} row={m} max={maxModel} showTokens />)}
        </Section>
      )}
    </div>
  );
}
