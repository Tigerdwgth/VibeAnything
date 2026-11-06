// 会话状态灯：黄灯 = agent 正在工作，绿灯 = 空闲。桌面版和手机版共用。
export const SESSION_WORKING_LABEL = '工作中';
export const SESSION_IDLE_LABEL = '空闲';

export function sessionLightTitle(isRunning) {
  return isRunning ? SESSION_WORKING_LABEL : SESSION_IDLE_LABEL;
}

export function sessionLightStyle(T, isRunning, glowPx) {
  const color = isRunning ? T.working : T.success;
  return {
    background: color,
    boxShadow: `0 0 ${glowPx}px ${color}`,
    animation: isRunning ? 'pulse 1.5s infinite' : undefined,
  };
}
