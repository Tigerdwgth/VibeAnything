// 小镇里的会话列表：一眼看出谁在干、谁干完了在等你，点一下直接开它的终端。
//
// 画布上的人会走动、会被桌子挡住，十几个人一屏时找人靠眼睛扫太慢；这里按
// 「等你确认 / 干完了 → 工作中 → 空闲 → 离线」排好（排序见 pixel-office/sessionPhase.ts），
// 列的是**所有机器**的会话 —— 小镇一次只画一台机器，别的机器上干完的会话也得看得见。
//
// 宽屏占一条侧栏（不压地图：画布按剩下的宽度生成楼层）；窄屏浮在画布右上角、
// 默认收起成一颗按钮，展开时也只占一角。颜色全部走 pixel-theme.js 的令牌。

/** 每个阶段的色点颜色、文字与要不要强调 */
const PHASE_LOOK = {
  permission: { color: 'var(--pixel-permission)', dim: 'var(--pixel-permission-dim)', text: '等你确认', mark: '!' },
  done: { color: 'var(--pixel-done)', dim: 'var(--pixel-done-dim)', text: '完成 · 等你', mark: '✓' },
  working: { color: 'var(--pixel-working)', dim: 'var(--pixel-working-dim)', text: '工作中', mark: '' },
  idle: { color: 'var(--pixel-idle)', dim: 'transparent', text: '空闲', mark: '' },
};
const OFFLINE_LOOK = { color: 'var(--pixel-offline)', dim: 'transparent', text: '离线', mark: '' };

const lookOf = (entry) => (entry.offline ? OFFLINE_LOOK : PHASE_LOOK[entry.phase]);

function StatusDot({ entry }) {
  const look = lookOf(entry);
  if (look.mark) {
    return (
      <span aria-hidden style={{
        width: 14, height: 14, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: look.color, color: 'var(--pixel-panel-bg)', fontSize: 10, fontWeight: 800, lineHeight: 1,
        borderRadius: 3,
      }}>{look.mark}</span>
    );
  }
  return (
    <span aria-hidden style={{ width: 14, height: 14, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
      <span
        className={entry.phase === 'working' && !entry.offline ? 'pixel-phase-pulse' : undefined}
        style={{
          width: 8, height: 8, borderRadius: '50%', background: look.color,
          boxShadow: entry.phase === 'working' && !entry.offline ? `0 0 6px ${look.color}` : undefined,
          opacity: entry.phase === 'idle' || entry.offline ? 0.75 : 1,
        }}
      />
    </span>
  );
}

function RosterRow({ entry, onPick }) {
  const look = lookOf(entry);
  const attention = !entry.offline && (entry.phase === 'done' || entry.phase === 'permission');
  const detail = entry.phase === 'working' && !entry.offline ? `${entry.tool} ${look.text}` : look.text;
  return (
    <button
      type="button"
      data-testid="pixel-roster-item"
      data-phase={entry.offline ? 'offline' : entry.phase}
      title={`${entry.label} · ${entry.machine}\n点击打开终端`}
      onClick={() => onPick(entry)}
      className="pixel-roster-row"
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
        padding: '6px 10px 6px 8px', border: 'none', cursor: 'pointer',
        borderLeft: `3px solid ${attention || entry.phase === 'working' ? look.color : 'transparent'}`,
        background: attention ? look.dim : 'transparent',
        color: 'var(--pixel-label-text)', fontFamily: 'var(--pixel-font)',
        opacity: entry.offline ? 0.6 : 1,
      }}
    >
      <StatusDot entry={entry} />
      <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{
          fontSize: 12, fontWeight: attention ? 700 : 600, lineHeight: 1.3,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{entry.label}</span>
        <span style={{
          fontSize: 10.5, lineHeight: 1.3, color: 'var(--pixel-label-sub)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          <span style={{ color: attention || entry.phase === 'working' ? look.color : undefined, fontWeight: attention ? 700 : 500 }}>{detail}</span>
          {' · '}{entry.machine}
        </span>
      </span>
    </button>
  );
}

/** 头部的计数：要你动手的、正在干的，各几个 */
function counts(entries) {
  let attention = 0;
  let working = 0;
  for (const e of entries) {
    if (e.offline) continue;
    if (e.phase === 'done' || e.phase === 'permission') attention++;
    else if (e.phase === 'working') working++;
  }
  return { attention, working };
}

function CountChip({ n, color, label }) {
  if (!n) return null;
  return (
    <span title={`${n} 个${label}`} style={{
      display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, fontWeight: 700,
      color, lineHeight: 1,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />{n}
    </span>
  );
}

const toggleBtn = {
  border: '1px solid var(--pixel-border)', background: 'var(--pixel-btn-bg)', color: 'var(--pixel-text-dim)',
  cursor: 'pointer', borderRadius: 5, fontFamily: 'var(--pixel-font)', lineHeight: 1,
};

export default function SessionRoster({ entries, open, floating, onToggle, onPick }) {
  const { attention, working } = counts(entries);

  if (!open) {
    // 收起：宽屏留一条窄边（还能看到有几个人在等你），窄屏是一颗浮动按钮
    return (
      <div
        data-testid="pixel-roster"
        data-open="false"
        style={floating ? {
          position: 'absolute', top: 8, right: 8, zIndex: 60,
        } : {
          width: 30, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center',
          gap: 10, paddingTop: 8, background: 'var(--pixel-panel-bg)', borderLeft: '1px solid var(--pixel-border)',
        }}
      >
        <button
          type="button"
          data-testid="pixel-roster-toggle"
          onClick={onToggle}
          title="展开会话列表"
          style={{
            ...toggleBtn,
            padding: floating ? '5px 9px' : '4px 6px',
            fontSize: 11, display: 'flex', alignItems: 'center', gap: 6,
            boxShadow: floating ? 'var(--pixel-shadow)' : undefined,
          }}
        >
          {floating ? <>会话 {entries.length}<CountChip n={attention} color="var(--pixel-done)" label="等你" /><CountChip n={working} color="var(--pixel-working)" label="工作中" /></> : '‹'}
        </button>
        {!floating && (
          <>
            <CountChip n={attention} color="var(--pixel-done)" label="等你" />
            <CountChip n={working} color="var(--pixel-working)" label="工作中" />
          </>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="pixel-roster"
      data-open="true"
      style={{
        display: 'flex', flexDirection: 'column', background: 'var(--pixel-panel-bg)',
        fontFamily: 'var(--pixel-font)', color: 'var(--pixel-label-text)',
        ...(floating ? {
          position: 'absolute', top: 8, right: 8, zIndex: 60, width: 'min(260px, calc(100% - 16px))',
          maxHeight: 'calc(100% - 16px)', border: '1px solid var(--pixel-border)', borderRadius: 8,
          boxShadow: 'var(--pixel-shadow)', overflow: 'hidden',
        } : {
          width: 220, flexShrink: 0, borderLeft: '1px solid var(--pixel-border)',
        }),
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px 7px 11px', flexShrink: 0,
        borderBottom: '1px solid var(--pixel-border)',
      }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 0.3 }}>会话</span>
        <span style={{ fontSize: 10.5, color: 'var(--pixel-label-sub)' }}>{entries.length}</span>
        <span style={{ flex: 1 }} />
        <CountChip n={attention} color="var(--pixel-done)" label="等你" />
        <CountChip n={working} color="var(--pixel-working)" label="工作中" />
        <button
          type="button"
          data-testid="pixel-roster-toggle"
          onClick={onToggle}
          title="收起会话列表"
          style={{ ...toggleBtn, padding: '3px 6px', fontSize: 11 }}
        >{floating ? '×' : '›'}</button>
      </div>
      <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, padding: '4px 0' }}>
        {entries.length === 0 ? (
          <div style={{ padding: '14px 12px', fontSize: 11.5, color: 'var(--pixel-label-sub)' }}>还没有会话</div>
        ) : entries.map((e) => <RosterRow key={e.key} entry={e} onPick={onPick} />)}
      </div>
    </div>
  );
}
