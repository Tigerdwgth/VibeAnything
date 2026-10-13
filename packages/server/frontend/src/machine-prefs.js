// 前端偏好记忆：默认开发机、每台机器上次浏览的目录、管理员的「隐藏他人会话」。
// 前端偏好只从这里读写，不在组件里散着裸 localStorage。
// resolveDefaultMachine 是纯函数（不碰 localStorage），可单测。

// 主力开发机：没有任何记忆时优先落在这台，避免每次进来都停在「所有开发机」，
// 侧边栏会话与目录树混着几台机器的内容。部署相关，调用方可覆盖。
export const DEFAULT_MACHINE_ID = 'macmini';

const MACHINE_KEY = 'preferredMachine';
const DIR_KEY = 'lastDir:';
const HIDE_OTHERS_KEY = 'hideOthers';

function store() {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

/**
 * 选出当前该用哪台开发机。
 * 优先级：用户上次的明确选择（含「所有开发机」= 空串）→ 主力开发机 → 第一台在线机器。
 * 记住的机器已离线时不能硬留：列表和目录树都会空着且没有任何提示。
 *
 * @param {{machineId:string}[]} machines 在线机器列表
 * @param {string|null} saved localStorage 里的选择；null = 从没选过，'' = 明确选了「所有」
 * @param {string} fallbackId 都没命中时的首选机器
 */
export function resolveDefaultMachine(machines, saved, fallbackId = DEFAULT_MACHINE_ID) {
  if (saved === '') return '';
  const ids = (machines || []).map(m => m.machineId).filter(Boolean);
  if (!ids.length) return saved || '';       // 机器列表还没到，先不改动选择
  if (saved && ids.includes(saved)) return saved;
  if (ids.includes(fallbackId)) return fallbackId;
  return ids[0];
}

export function loadPreferredMachine() {
  return store()?.getItem(MACHINE_KEY) ?? null;
}

export function savePreferredMachine(machineId) {
  store()?.setItem(MACHINE_KEY, machineId || '');
}

export function loadLastDir(machineId) {
  if (!machineId) return null;
  return store()?.getItem(DIR_KEY + machineId) || null;
}

export function saveLastDir(machineId, dir) {
  if (!machineId || !dir) return;
  store()?.setItem(DIR_KEY + machineId, dir);
}

/** 管理员的「隐藏他人会话」开关，默认开着。 */
export function loadHideOthers() {
  return store()?.getItem(HIDE_OTHERS_KEY) !== 'false';
}

export function saveHideOthers(hide) {
  store()?.setItem(HIDE_OTHERS_KEY, String(hide));
}
