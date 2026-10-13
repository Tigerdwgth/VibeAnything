import { useCallback, useEffect, useState } from 'react';
import { useTheme } from './theme';
import { copyTextToClipboard } from './clipboard';
import { shortMachineId, machineTitle } from './machine-name';

// 开发机管理（仅管理员）：看台账 + 发一次性邀请码 + 撤销。
//
// 这个面板替掉的是装机时那套手术：ssh 到 dashboard 改 systemd unit 的
// `MACHINE_TOKENS=`、重启服务（打断所有浏览器连接）、再把那串明文 token 抄进部署文档。
// 现在点一下出一个码，码只在这一次显示（服务端只存它的 sha256），在新机器上贴两条命令就完事。
//
// 面板只显示元信息，永远拿不到任何机器的 token —— 列表接口里没有，设计如此。

/** 相对时间，列表里只要「多久没见过」这个量级。 */
function since(ts) {
  if (!ts) return '从未连接';
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export default function MachinesPanel({ token, onClose }) {
  const T = useTheme();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState(null);     // 刚签发的码：{code, expiresAt, machineId}
  const [newLabel, setNewLabel] = useState('');
  const [copied, setCopied] = useState('');

  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/machines', { headers: authHeaders });
      const body = await res.json();
      if (!res.ok) { setError(body.error || '读取失败'); return; }
      setData(body);
      setError('');
    } catch {
      setError('连接失败');
    }
  }, [token]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  /** 签发邀请码。machineId 给定 = 给已有机器换一把新 token（泄露/重装都走这条）。 */
  async function createInvite(machineId = null) {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/machines/invite', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ machineId, label: machineId ? null : (newLabel.trim() || null) }),
      });
      const body = await res.json();
      if (!res.ok) { setError(body.error || '签发失败'); return; }
      setInvite(body);
      setNewLabel('');
      load();
    } catch {
      setError('连接失败');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(machineId) {
    // 撤销是不可逆的：那台机器下一次握手就连不上了，要重新装机
    if (!window.confirm(`撤销 ${machineId} 的 token？它会立刻掉线，需要用新的邀请码重装。`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/machines/${encodeURIComponent(machineId)}`, { method: 'DELETE', headers: authHeaders });
      const body = await res.json();
      if (!res.ok) setError(body.error || '撤销失败');
      load();
    } catch {
      setError('连接失败');
    } finally {
      setBusy(false);
    }
  }

  function copy(text, tag) {
    // HTTP 页面上 navigator.clipboard 整个不存在 —— clipboard.js 里有 execCommand 兜底，
    // 必须同步在用户手势栈里调（见 LESSONS_LEARNED 2026-07-13）。
    // 失败一定要给出口：不然用户看到的就是「点了没反应」。
    copyTextToClipboard(text, {
      onSuccess: () => { setCopied(tag); setTimeout(() => setCopied(''), 1500); },
      onFailure: () => setError('浏览器拒绝了复制，手动选中上面那段文字即可'),
    });
  }

  const joinCommand = invite
    ? `vibeanything join --server ${location.origin} --code ${invite.code}${invite.machineId ? '' : ' --machine-id <这台机器的名字>'}`
    : '';

  const btn = (extra = {}) => ({
    minHeight: '30px', padding: '5px 12px', borderRadius: T.radiusSm,
    border: `1px solid ${T.border}`, background: 'transparent',
    color: T.textSecondary, fontSize: '0.78rem', cursor: 'pointer', ...extra,
  });

  return (
    <div
      onClick={e => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 80, padding: '16px',
      }}
    >
      <div style={{
        background: T.bgPanel, border: `1px solid ${T.border}`, borderRadius: T.radiusLg || '10px',
        width: 'min(720px, 100%)', maxHeight: '86vh', overflowY: 'auto', padding: '18px 20px',
        color: T.textPrimary, fontFamily: T.fontSans,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '12px' }}>
          <strong style={{ flex: 1, fontSize: '0.95rem' }}>开发机</strong>
          <button type="button" onClick={onClose} style={btn()}>关闭</button>
        </div>

        {error && (
          <div style={{ marginBottom: '10px', padding: '8px 10px', borderRadius: T.radiusSm, background: T.dangerDim, color: T.danger, fontSize: '0.8rem' }}>
            {error}
          </div>
        )}

        {/* 签发：留空备注也能发，备注只是列表里认人用的 */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
          <input
            value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
            placeholder="备注（可选，如「实验室 4090」）"
            aria-label="新机器备注"
            style={{
              flex: 1, minHeight: '32px', padding: '6px 10px', borderRadius: T.radiusSm,
              border: `1px solid ${T.border}`, background: T.bgInput, color: T.textPrimary, fontSize: '0.8rem',
            }}
          />
          <button type="button" disabled={busy} onClick={() => createInvite(null)}
            style={btn({ border: `1px solid ${T.borderAccent}`, color: T.accent })}>＋ 添加开发机</button>
        </div>

        {invite && (
          <div style={{
            marginBottom: '16px', padding: '12px', borderRadius: T.radiusSm,
            border: `1px solid ${T.borderAccent}`, background: T.accentDim,
          }}>
            <div style={{ fontSize: '0.78rem', color: T.textSecondary, marginBottom: '6px' }}>
              邀请码（一次性，{new Date(invite.expiresAt).toLocaleTimeString()} 前有效
              {invite.machineId ? `，仅限 ${invite.machineId}` : ''}）—— 只显示这一次
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' }}>
              <code style={{ flex: 1, fontFamily: T.fontMono, fontSize: '0.84rem', wordBreak: 'break-all' }}>{invite.code}</code>
              <button type="button" onClick={() => copy(invite.code, 'code')} style={btn()}>
                {copied === 'code' ? '已复制' : '复制'}
              </button>
            </div>
            <div style={{ fontSize: '0.78rem', color: T.textSecondary, marginBottom: '4px' }}>在新机器上执行：</div>
            <pre style={{
              margin: 0, padding: '8px 10px', borderRadius: T.radiusSm, background: T.bgInput,
              fontFamily: T.fontMono, fontSize: '0.76rem', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            }}>{`${joinCommand}\nvibeanything service install`}</pre>
            <button type="button" onClick={() => copy(`${joinCommand}\nvibeanything service install`, 'cmd')} style={btn({ marginTop: '8px' })}>
              {copied === 'cmd' ? '已复制' : '复制命令'}
            </button>
          </div>
        )}

        {/* 台账 */}
        {!data ? (
          <div style={{ color: T.textMuted, fontSize: '0.8rem' }}>读取中…</div>
        ) : (
          <>
            {data.machines.length === 0 && (
              <div style={{ color: T.textMuted, fontSize: '0.8rem', marginBottom: '10px' }}>
                还没有机器用邀请码装过机。点上面「添加开发机」发一个码。
              </div>
            )}
            {/* 待用邀请码：签发完没人用、或者码丢了，这里是唯一能看出「外面还有一个有效码」的地方 */}
            {data.pendingInvites?.length > 0 && (
              <div style={{ marginBottom: '8px', fontSize: '0.76rem', color: T.textMuted }}>
                还有 {data.pendingInvites.length} 个邀请码没被用掉
                {data.pendingInvites.some(i => i.machineId) && (
                  <>（指名：{data.pendingInvites.filter(i => i.machineId).map(i => i.machineId).join('、')}）</>
                )}
                —— 用掉或过期后自动消失
              </div>
            )}
            {data.machines.map(m => (
              <div key={m.machineId} style={{
                display: 'flex', alignItems: 'center', gap: '10px',
                padding: '9px 2px', borderTop: `1px solid ${T.border}`, fontSize: '0.82rem',
              }}>
                <span title={m.online ? '在线' : '离线'} style={{
                  width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
                  background: m.online ? T.success : T.textMuted,
                }} />
                <span style={{ flex: 1, minWidth: 0, fontFamily: T.fontMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={machineTitle(m.machineId)}>
                  {shortMachineId(m.machineId)}
                  {m.label && <span style={{ color: T.textMuted, marginLeft: '8px', fontFamily: T.fontSans }}>{m.label}</span>}
                </span>
                {m.createdBy && (
                  <span style={{ color: T.textMuted, fontSize: '0.72rem', flexShrink: 0 }} title="谁签发的邀请码">{m.createdBy} 装的</span>
                )}
                <span style={{ color: T.textMuted, fontSize: '0.74rem', flexShrink: 0 }}>{since(m.lastSeen)}</span>
                <button type="button" disabled={busy} onClick={() => createInvite(m.machineId)} style={btn()}
                  title="给这台机器换一把新 token（旧的当场失效）">换 token</button>
                <button type="button" disabled={busy} onClick={() => revoke(m.machineId)}
                  style={btn({ color: T.danger, borderColor: T.danger })}>撤销</button>
              </div>
            ))}

            {/* 还在用旧的全局 token 的机器：它们不在台账里，但确实连着 */}
            {data.legacyMachines?.length > 0 && (
              <div style={{ marginTop: '14px', paddingTop: '10px', borderTop: `1px solid ${T.border}` }}>
                <div style={{ fontSize: '0.78rem', color: T.textMuted, marginBottom: '6px' }}>
                  仍在用旧的全局 token（环境变量里那份名单，不绑机器）：换装后就能从这里消失
                </div>
                {data.legacyMachines.map(m => (
                  <div key={m.machineId} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 2px', fontSize: '0.82rem' }}>
                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: T.warning || T.textMuted, flexShrink: 0 }} />
                    <span style={{ flex: 1, fontFamily: T.fontMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={machineTitle(m.machineId)}>{shortMachineId(m.machineId)}</span>
                    <button type="button" disabled={busy} onClick={() => createInvite(m.machineId)} style={btn()}>发码换装</button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
