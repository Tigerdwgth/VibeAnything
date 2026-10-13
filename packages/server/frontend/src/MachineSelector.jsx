import { useTheme } from './theme';
import { shortMachineId, machineTitle } from './machine-name';

export default function MachineSelector({ machines, currentMachine, onSelect }) {
  const T = useTheme();

  if (!machines || machines.length <= 1) return null;

  return (
    <div style={{ marginBottom: '1rem', padding: '0 0.75rem' }}>
      <label style={{
        display: 'block',
        color: T.textSecondary,
        fontSize: '0.8rem',
        marginBottom: '0.5rem'
      }}>
        选择开发机
      </label>
      <select
        value={currentMachine || ''}
        onChange={(e) => onSelect(e.target.value)}
        style={{
          width: '100%',
          padding: '0.5rem',
          background: T.bgBase,
          border: `1px solid ${T.border}`,
          borderRadius: T.radiusSm,
          color: T.textPrimary,
          fontSize: '0.875rem',
          cursor: 'pointer'
        }}
      >
        <option value="">所有开发机</option>
        {machines.map(m => (
          // 显示短名（完整名常带 DNS 域或一串随机后缀，下拉里会被截断）；
          // 完整名放 title，和侧栏的机器胶囊同一份规则（machine-name.js）
          <option key={m.machineId} value={m.machineId} title={machineTitle(m.machineId)}>
            {shortMachineId(m.machineId)}（{m.sessionCount} 个会话）
          </option>
        ))}
      </select>
    </div>
  );
}
