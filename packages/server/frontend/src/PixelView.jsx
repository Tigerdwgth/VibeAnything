import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import PixelApp from './PixelApp';
import { useTheme } from './theme';
import { pixelThemeCss, PIXEL_SCOPE_CLASS } from './pixel-theme';
import { getRunningSessionTitle } from './session-list-utils';
import { shortMachineId } from './machine-name';
import {
  buildTownSpec, buildFloorPlan, emitFloorLayout, townSessionKey, townMachineKey,
} from './pixel-office/layout/townLayout.js';
import {
  phaseFromRunning, phaseFromHook, phaseAfterFocus, sortRoster,
} from './pixel-office/sessionPhase.js';
import { setStatusPalette } from './pixel-office/statusPalette.js';
import SessionRoster from './pixel-components/SessionRoster.jsx';

// 把 Dashboard 的会话状态翻译成像素小镇子系统（pixel-agents 移植版）认的那套 window message。
//
// 这一层以前的问题全集中在一句话上：**画布上的小人和真实会话对不上**。
//   · 标签写的是 `Agent #1`、`Agent #2`（子系统的内部自增 id），谁是谁只能猜；
//   · 初始化时给每个小人发一条硬编码的 `Working...`，于是所有人永远「在干活」；
//   · hook 事件里的 sessionId 和 active_sessions 里的 sessionId **不是同一个命名空间**
//     （一个是 claude 的 UUID，一个是 tmux 会话名），用它去查 id 会**凭空造出**
//     一个画布上不存在的小人；
//   · id 映射是 module 级的 Map，会话关掉也不回收，切走视图再切回来还会重复初始化。
//
// 现在的规则：
//   · 一台机器 + 一个 sessionId = 一个小人（key 带 machineId，两台机器上同名 tmux 不会撞）；
//   · 会话消失就回收 id（画布上移除 + 两张表都删）；
//   · 红绿灯**只认 active_sessions 里的 isRunning**（它本身就是 hook 驱动的，与侧栏同源），
//     hook 事件只用来「立刻点亮」，且查不到已知会话就丢掉，绝不新建小人；
//   · 标签、机器名、工作目录、在不在跑，通过 agentInfo 一起下发给子系统去画。
//
// 2026-10-10 的大改：**一台开发机一个标签页，一层楼只画这一台机器**。
// 之前四台机器挤在同一张地图上（45×36 格），而画布只有 1360×957、缩放还是取整的，
// 算下来只有 1× —— 小镇缩在屏幕中间一半的面积里、小人只有 16 像素高，
// 就是用户说的「四个开发机全都显示在一页上，太大，看不清」「房间没有占满整个页面」。
// 现在反过来：先量画布（这里的 stage，单位是设备像素，与 OfficeCanvas 的 backing store
// 同一条算式），再按画布生成正好铺满它的网格，一个分类文件夹一间房铺满整层楼
// （见 pixel-office/layout/townLayout.ts）。所以这一层要负责三件事：
// 「谁是谁」、「谁该坐哪」、以及「这块画布有多大」。

const sessionKey = townSessionKey;

/**
 * 清空模块级状态（id 映射 + 「已初始化」标记）。
 *
 * 这些状态**必须**是模块级的：子系统的 officeState 也是模块级的，组件卸载重挂时画布上的
 * 小人还在，id 空间得跟着保持一致（否则就是「切视图回来一堆幽灵小人占着座位」）。
 * 代价是单测之间会互相串，所以给测试一个重置入口 —— 与服务端那些台账的
 * `_resetForTest` 同一个路子。生产代码不要调它。
 */
// 测试入口，不是组件；放在这里是因为它清的正是本文件的模块级状态
// eslint-disable-next-line react-refresh/only-export-components
export function __resetPixelViewStateForTest() {
  keyToId.clear();
  idToKey.clear();
  idToSession.clear();
  sentSeats.clear();
  phaseByKey.clear();
  runningByKey.clear();
  activeSig = null;
  nextAgentId = 1;
}

// key ↔ 数字 id 的双向表。必须是 module 级：子系统的 officeState 也是 module 级的，
// 组件卸载重挂时画布上的小人还在，id 空间得跟着保持一致。
const keyToId = new Map();
const idToKey = new Map();
const idToSession = new Map();   // id → { machineId, sessionId }，点小人跳转用
// id → 上次下发过的座位 uid。也必须是模块级：座位的真身在画布（module 级 officeState）上，
// 用组件级 ref 记的话，切走视图再回来会以为谁都没安排过，于是重发一遍整体落座。
const sentSeats = new Map();
// 当前画布上那层楼是按哪套结构生成的。**不能只看 localStorage**：隐私模式/配额满时
// 写不进去，getItem 永远返回 null，于是每轮都判定「结构变了」→ 每 2.5 秒重建地图、
// 所有人跟着瞬移一次。localStorage 只负责跨页面刷新保存，真值在这里。
let activeSig = null;
let nextAgentId = 1;
// 会话 key → 工作阶段（工作中 / 等权限 / 干完了等你 / 空闲，见 pixel-office/sessionPhase.ts），
// 以及上一轮会话列表里的 isRunning（「干完了」要靠它判出从在跑到不在跑的那一下）。
// 必须是模块级：「干完了、等你去看」的标记要熬过切走视图再切回来。
// 覆盖所有机器的会话 —— 小镇只画当前这台，但会话列表要列全部。
const phaseByKey = new Map();
const runningByKey = new Map();
// 阶段表变了要让会话列表重画：表在 React 之外，按「外部数据源」订阅（useSyncExternalStore）
let phaseVersion = 0;
const phaseListeners = new Set();
function notifyPhases() {
  phaseVersion++;
  for (const listener of phaseListeners) listener();
}
const subscribePhases = (listener) => {
  phaseListeners.add(listener);
  return () => phaseListeners.delete(listener);
};
const getPhaseVersion = () => phaseVersion;

function agentIdFor(session) {
  const key = sessionKey(session);
  if (!keyToId.has(key)) {
    const id = nextAgentId++;
    keyToId.set(key, id);
    idToKey.set(id, key);
  }
  const id = keyToId.get(key);
  idToSession.set(id, { machineId: session.machineId, sessionId: session.sessionId });
  return id;
}

/** 会话没了：把 id 回收，否则这两张表只增不减，画布上也会留幽灵。 */
function releaseAgentId(id) {
  const key = idToKey.get(id);
  if (key) keyToId.delete(key);
  idToKey.delete(id);
  idToSession.delete(id);
}

// ── 持久化 ────────────────────────────────────────────────────
// 子系统原来跑在 VS Code 扩展里，布局与座位是发给扩展宿主存的（saveLayout / saveAgentSeats）。
// 移植进浏览器后那条消息没人接：点「保存」有反馈但什么都没存，刷新页面家具回默认办公室，
// 而且**每次进这个视图小人都换座位**（座位是随机分的）—— 同一个人每次坐在不同工位，
// 「谁是谁」就更记不住了。这里把两样都落到 localStorage。
//
// 布局与签名**按机器分开存**：现在一台机器一个标签页，切回来还得是自己那层楼。
const LAYOUT_PREFIX = 'vibeanything:pixelLayout:';
const SIG_PREFIX = 'vibeanything:pixelLayoutSig:';
const SEATS_KEY = 'vibeanything:pixelSeats';   // sessionKey → { palette, hueShift, seatId }
const MACHINE_KEY = 'vibeanything:pixelMachine';
// 旧版（四台机器挤一张图）存下来的整镇布局，几十到上百 KB，新签名永远对不上它。
// 留着只是白占配额，开一次这个视图就清掉。
const LEGACY_KEYS = ['vibeanything:pixelLayout', 'vibeanything:pixelLayoutSig'];
/** 画布尺寸稳定多久才算一次「变了」（毫秒）—— 见下面量尺寸那个 effect */
const STAGE_SETTLE_MS = 160;

function pruneLegacyStorage() {
  for (const key of LEGACY_KEYS) {
    try { localStorage.removeItem(key); } catch { /* 隐私模式：无所谓 */ }
  }
}

function loadSavedLayout(machineKey) {
  try {
    const raw = localStorage.getItem(LAYOUT_PREFIX + machineKey);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function loadSavedSeats() {
  try {
    const raw = localStorage.getItem(SEATS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function saveSeatsByKey(next) {
  try { localStorage.setItem(SEATS_KEY, JSON.stringify(next)); } catch { /* 隐私模式/配额满 */ }
}

function loadPreferredMachine() {
  try { return localStorage.getItem(MACHINE_KEY) || ''; } catch { return ''; }
}

/**
 * 上次各会话坐在哪 —— 交给 planFloor 做「还坐原位」的依据。
 *
 * 两份数据合起来用：localStorage 是跨刷新的，`sentSeats` 是本页**内存里的真值**
 * （localStorage 可能写不进去）。少了后者，新开一个会话时它会抢走别人的座位，
 * 整间屋子跟着重排一次 —— 而用户要的是「新来的人自己找个空位坐下」。
 */
function preferredSeatsOf(savedSeats) {
  const out = {};
  for (const [key, meta] of Object.entries(savedSeats)) {
    if (meta && meta.seatId) out[key] = meta.seatId;
  }
  for (const [id, seat] of sentSeats) {
    const key = idToKey.get(id);
    if (key) out[key] = seat;
  }
  return out;
}

/**
 * 这层楼对应的地图：存档里的签名还对得上就用存档（保住用户在编辑模式里摆过的家具），
 * 对不上说明目录增删了、画布尺寸变了、或者某间房要多摆一排桌子 —— 重新生成一张并存起来。
 */
function layoutFor(plan) {
  const saved = loadSavedLayout(plan.machineKey);
  let savedSig = null;
  try { savedSig = localStorage.getItem(SIG_PREFIX + plan.machineKey); } catch { /* 隐私模式 */ }
  if (saved && savedSig === plan.signature) return saved;
  const layout = emitFloorLayout(plan);
  saveLayoutAndSig(plan.machineKey, layout, plan.signature);
  return layout;
}

function saveLayoutAndSig(machineKey, layout, signature) {
  try {
    localStorage.setItem(LAYOUT_PREFIX + machineKey, JSON.stringify(layout));
    localStorage.setItem(SIG_PREFIX + machineKey, signature);
  } catch { /* 隐私模式/配额满：这一轮用内存里的布局，下次再试 */ }
}

/** 把当前布局存成文件下载下来。 */
function exportLayoutFile(machineKey) {
  const layout = loadSavedLayout(machineKey);
  if (!layout) return;
  const blob = new Blob([JSON.stringify(layout, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pixel-floor-${machineKey}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  // 立刻 revoke 会让部分浏览器来不及开始下载，挪到下一轮事件循环
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** 选一个布局文件读进来。 */
function importLayoutFile(onLoaded) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        // 只认长得像布局的对象，别把任意 JSON 塞进引擎
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.furniture)) onLoaded(parsed);
      } catch { /* 选错文件：什么都不做 */ }
    };
    reader.readAsText(file);
  };
  input.click();
}

/**
 * 一个 agent 的外观与座位。
 *
 * 外观（肤色 / 色相）存过就按存的来，没存过按会话名算一个稳定色相；
 * **座位由楼层计划决定**，不是直接拿上次存的 —— 会话换了工作目录就得换房间，
 * 拿老座位会把人留在原来那间屋里（planFloor 只在同一间房内部认旧座位）。
 */
function metaFor(id, seatId, savedSeats) {
  const key = idToKey.get(id) || String(id);
  const saved = savedSeats[key];
  return {
    ...(saved && saved.palette !== undefined ? { palette: saved.palette } : {}),
    hueShift: saved && saved.hueShift !== undefined ? saved.hueShift : hueShiftFor(key),
    ...(seatId ? { seatId } : {}),
  };
}

/** 同一个会话每次都得到同一个色相，不同会话尽量错开 —— 这是「谁是谁」的第一道线索。 */
function hueShiftFor(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) % 360;
  return hash;
}

const post = (data) => window.dispatchEvent(new MessageEvent('message', { data }));

/** 小人身上要显示的信息。会话改名、换目录、红绿灯变化都从这里下发。 */
function infoFor(session) {
  return {
    label: getRunningSessionTitle(session),
    machine: shortMachineId(session.machineId),
    cwd: session.cwd || '',
    tool: session.tool || 'claude',
    running: !!session.isRunning,
    // 本浏览器 localStorage 里留着标签、但机器上已经没有这个会话了（关机/几天前关掉的）。
    // 照旧画出来，但要标清楚，别让人以为那是个活会话。
    offline: !!session.offline,
  };
}

/** 正在跑的时候，气泡里写什么。工具名由子系统从这行字里抽（extractToolName）。 */
const runningStatus = (info) => `${info.tool}: ${info.cwd ? info.cwd.split('/').filter(Boolean).slice(-1)[0] : info.label}`;

/**
 * 把一个小人切到某个工作阶段。子系统原有的几条消息各管一摊（工具气泡、agentStatuses、
 * 权限标记），这里一次按固定顺序发齐，**agentPhase 永远最后发** —— 它决定最终的
 * 坐姿与头顶气泡，前面几条只负责把各自的状态对齐，不能留下上一阶段的残渣
 * （以前从「等权限」恢复工作时只发 agentToolStart，agentStatuses 一直停在 waiting，
 * 名牌就一直挂着「等待确认」）。
 */
function postPhase(id, phase, info) {
  if (phase === 'working') {
    post({ type: 'agentToolsClear', id });   // 清掉上一轮的权限标记，工具气泡从头来
    post({ type: 'agentToolStart', id, toolId: `run-${id}`, status: runningStatus(info) });
    post({ type: 'agentStatus', id, status: 'active' });
  } else if (phase === 'permission') {
    post({ type: 'agentToolPermission', id });
    post({ type: 'agentStatus', id, status: 'waiting' });
  } else {
    post({ type: 'agentToolsClear', id });
    post({ type: 'agentStatus', id, status: 'idle' });
  }
  post({ type: 'agentPhase', id, phase });
}

/** 画布那块地方的设备像素尺寸（与 OfficeCanvas.resizeCanvas 同一条算式） */
function measureStage(el) {
  const r = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return { width: Math.round(r.width * dpr), height: Math.round(r.height * dpr) };
}

/** hook 事件指的是哪个会话（返回会话 key，认不出就 null）。只认已知会话，绝不新建。 */
function sessionKeyOfHook(machineId, candidates) {
  for (const sid of candidates) {
    const direct = `${machineId || 'local'}::${sid}`;
    if (phaseByKey.has(direct)) return direct;
    // machineId 没带上时退一步：按 sessionId 在已知会话里找唯一匹配
    const matches = [...phaseByKey.keys()].filter((k) => k.endsWith(`::${sid}`));
    if (matches.length === 1) return matches[0];
  }
  return null;
}

/** 会话列表的「窄屏」判据：窄屏上列表浮在画布上（默认收起），宽屏上占一条侧栏 */
const NARROW_QUERY = '(max-width: 719px)';
const ROSTER_OPEN_KEY = 'vibeanything:pixelRosterOpen';

function loadRosterOpen(narrow) {
  try {
    const raw = localStorage.getItem(ROSTER_OPEN_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch { /* 隐私模式 */ }
  return !narrow;
}

/** 这台机器一共几个会话（标签页上的计数） */
const sessionCountOf = (house) => house.rooms.reduce((n, r) => n + r.sessionKeys.length, 0);

/**
 * 当前该显示哪台机器：记住的那台还在就用它，否则用会话最多的那台。
 * 机器下线时自动换一台 —— 停在一台已经没有的机器上只会看到一屏空房间。
 */
function pickHouse(houses, preferred) {
  if (!houses.length) return null;
  const hit = houses.find((h) => h.key === preferred);
  if (hit) return hit;
  return [...houses].sort(
    (a, b) => sessionCountOf(b) - sessionCountOf(a) || a.key.localeCompare(b.key),
  )[0];
}

export default function PixelView({ activeSessions, machines, foldersByMachine, activeSession, onFocusSession, onCloseSession }) {
  const T = useTheme();
  // id → 上一轮下发过的状态，用来只在**变化时**发消息：activeSessions 每 2.5 秒就刷一次，
  // 无脑重发会让子系统不停地重建气泡、重放提示音。
  // 注意它只是「发过什么」的备忘，**不能**当成「画布上有谁」—— 后者必须用模块级的
  // idToKey：sentRef 随组件卸载销毁，而子系统的 officeState 是模块级的，
  // 用它对账会导致「切到终端视图再回来，已关掉的会话还坐在椅子上」且座位被占死。
  const sentRef = useRef(new Map());
  // 本次**挂载**有没有初始化过。注意它不能是模块级的：画布（officeState）是模块级的、
  // 切走再回来人还在，但 PixelApp 里的 React 状态（agents / layoutReady）是归零的 ——
  // 不每次挂载都把 existingAgents + layoutLoaded 重发一遍，layoutReady 就永远是 false，
  // 切回这个视图只会看到一个 "Loading..."。
  const mountedRef = useRef(false);
  // 当前生效的签名与机器。导入布局时要拿它们顶掉存档，否则下一轮就被重新生成顶回去。
  const sigRef = useRef(null);
  const machineRef = useRef('');
  // 画布那块地方（设备像素）。网格就是按它算出来的，所以必须和 OfficeCanvas 量的是同一个盒子。
  const stageRef = useRef(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [preferredMachine, setPreferredMachine] = useState(loadPreferredMachine);
  // 阶段表（模块级）变了之后让会话列表重画一次
  useSyncExternalStore(subscribePhases, getPhaseVersion);
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  const [rosterOpen, setRosterOpen] = useState(() => loadRosterOpen(window.matchMedia(NARROW_QUERY).matches));

  // 画布的状态色（canvas 读不到 CSS 变量）跟着主题走，与侧栏红绿灯同一个黄
  useEffect(() => { setStatusPalette({ working: T.working }); }, [T]);

  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const toggleRoster = () => {
    setRosterOpen((open) => {
      try { localStorage.setItem(ROSTER_OPEN_KEY, open ? '0' : '1'); } catch { /* 隐私模式 */ }
      return !open;
    });
  };

  // 机器 → 分类文件夹 → 会话。标签页和楼层规划都从这一份结构来。
  const houses = useMemo(
    () => buildTownSpec(activeSessions, machines || [], foldersByMachine),
    [activeSessions, machines, foldersByMachine],
  );
  // 在 machines 里 = relay 认它在线；只在 openTerminals 里的机器是离线的老标签
  const liveKeys = useMemo(() => new Set((machines || []).map((m) => m.machineId)), [machines]);
  const house = useMemo(() => pickHouse(houses, preferredMachine), [houses, preferredMachine]);

  const selectMachine = (key) => {
    setPreferredMachine(key);
    try { localStorage.setItem(MACHINE_KEY, key); } catch { /* 隐私模式 */ }
  };

  // 画布尺寸：与 OfficeCanvas.resizeCanvas 同一条算式（容器 CSS 尺寸 × dpr），
  // 网格按它算出来才能正好铺满 —— 差一点点就会被取整的缩放砍掉一整档。
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    let timer = 0;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const next = { width: Math.round(r.width * dpr), height: Math.round(r.height * dpr) };
      setStage((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
    };
    // 拖窗口 / 拖侧栏分隔条时 ResizeObserver 是连发的，而尺寸每跨过一格就要重建一次楼层
    // （上千个瓦片 + 一次 localStorage 写 + 所有人瞬移）。等它停下来再量。
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(measure, STAGE_SETTLE_MS);
    };
    measure();
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    // 纯 dpr 变化（把窗口拖到外接 1× 屏）不改元素的 CSS 尺寸，ResizeObserver 不会触发
    window.addEventListener('resize', schedule);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, []);

  useEffect(() => {
    // 阶段：**所有机器**的会话都推进一遍（会话列表要列全部），画布只画当前这台
    let phasesChanged = false;
    const alive = new Set();
    for (const s of activeSessions) {
      if (!s?.sessionId) continue;
      const key = sessionKey(s);
      alive.add(key);
      const running = !!s.isRunning;
      const next = phaseFromRunning(phaseByKey.get(key), runningByKey.get(key), running);
      runningByKey.set(key, running);
      if (phaseByKey.get(key) !== next) { phaseByKey.set(key, next); phasesChanged = true; }
    }
    for (const key of [...phaseByKey.keys()]) {
      if (alive.has(key)) continue;
      phaseByKey.delete(key);
      runningByKey.delete(key);
      phasesChanged = true;
    }
    if (phasesChanged) notifyPhases();

    if (!house) {
      // 一台机器都没有了：PixelApp 跟着卸载，它的 React 状态（layoutReady / agents）归零。
      // 机器回来时 PixelApp 重新挂载，必须当成一次新的挂载把人和地图重灌一遍 ——
      // 否则签名没变就不发 layoutLoaded，画布永远停在 Loading...（relay 重启时就是这样）。
      mountedRef.current = false;
      sentRef.current.clear();
      return;
    }
    pruneLegacyStorage();
    machineRef.current = house.key;

    // 只画当前标签页这台机器的会话；别的机器的小人由下面的「消失的会话」那一步收走
    const want = new Map();
    for (const s of activeSessions) {
      if (!s?.sessionId || townMachineKey(s) !== house.key) continue;
      want.set(agentIdFor(s), s);
    }

    // 这层楼：一个分类文件夹一间房，铺满整块画布；工位按会话数摆。
    // 每轮都算（很便宜，只是几何不生成瓦片），因为「谁该坐哪」每轮都要对一遍。
    const savedSeats = loadSavedSeats();
    // 尺寸**现量**，不用 stage 状态：挂载那一轮 stage 还是 {0,0}（量尺寸的 effect 刚
    // setState，还没重渲染），拿它规划会先按兜底网格生成一层楼、连签名一起写进存档，
    // 把用户在编辑模式里摆好的家具冲掉 —— 每次切回像素视图都会冲一次。
    // stage 状态只当「尺寸变了，重跑一遍」的触发器。
    const { plan } = buildFloorPlan(house, measureStage(stageRef.current), {
      preferredSeats: preferredSeatsOf(savedSeats),
    });
    sigRef.current = plan.signature;
    const seatOf = (session) => plan.seatOfSession[sessionKey(session)];

    // ① 消失的会话（含切标签页时别台机器的人）：从画布移除并回收 id。
    // 基准是**模块级**的 idToKey
    for (const id of [...idToKey.keys()]) {
      if (!want.has(id)) {
        post({ type: 'agentClosed', id });
        sentRef.current.delete(id);
        sentSeats.delete(id);
        releaseAgentId(id);
      }
    }

    const ids = [...want.keys()];
    const firstRun = !mountedRef.current;
    mountedRef.current = true;

    // ② 本次挂载的首轮：把人和地图一起灌进去。
    // existingAgents 会缓冲，layoutLoaded 之后才真正落座（座位要先存在）。
    if (firstRun) {
      const agentMeta = {};
      for (const [id, session] of want) agentMeta[id] = metaFor(id, seatOf(session), savedSeats);
      post({ type: 'existingAgents', agents: ids, agentMeta });
    }
    // 地图：首轮必须发（layoutReady 要靠它翻），之后只在这层楼的构成变了时重建
    const rebuilt = firstRun || plan.signature !== activeSig;
    if (rebuilt) {
      post({ type: 'layoutLoaded', layout: layoutFor(plan) });
      activeSig = plan.signature;
    }

    // ③ 新增的会话
    for (const [id, session] of want) {
      if (!sentRef.current.has(id)) {
        post({ type: 'agentCreated', id, ...metaFor(id, seatOf(session), savedSeats) });
      }
    }

    // ④ 信息与阶段：只在真的变了的时候发。
    // running 也要比 —— 名牌上的状态以前读的就是 info.running，而它只在改名换目录时
    // 才重发，于是会话开跑之后名牌一直写着「空闲」。
    for (const [id, session] of want) {
      const info = infoFor(session);
      const phase = phaseByKey.get(sessionKey(session));
      const prev = sentRef.current.get(id);
      if (!prev || prev.label !== info.label || prev.machine !== info.machine
          || prev.cwd !== info.cwd || prev.offline !== info.offline || prev.running !== info.running) {
        post({ type: 'agentInfo', id, info });
      }
      if (!prev || prev.phase !== phase) postPhase(id, phase, info);
      sentRef.current.set(id, { ...info, phase });
    }

    // ⑤ 座位：一个分类文件夹一间房，所以谁坐哪是算出来的，不是随机分的。
    // 变了就整体重排一次（一个一个改会互相挡住，见 officeState.applySeatPlan）。
    const seatPlan = {};
    let seatsChanged = false;
    for (const [id, session] of want) {
      const seat = seatOf(session);
      if (!seat) continue;                       // 工位不够（极限情况）：先让他站着，别顶掉别人
      seatPlan[id] = seat;
      if (sentSeats.get(id) !== seat) seatsChanged = true;
    }
    if (rebuilt || seatsChanged) {
      // 地图刚重建 → 所有人瞬间各回各屋（原地坐着的人跟着墙一起挪了）；
      // 只是某个会话换了分类文件夹 → 让他自己走去新房间，看得出发生了什么。
      post({ type: 'seatPlan', plan: seatPlan, walk: !rebuilt });
      sentSeats.clear();
      for (const [id, seat] of Object.entries(seatPlan)) sentSeats.set(Number(id), seat);
    }
  }, [house, stage, activeSessions]);

  /**
   * 打开某个会话的终端（点小人、点名牌、点会话列表都走这里）。
   * 用户去看了，「干完了、等你」的提醒就到此为止。
   */
  const acknowledgeDone = useCallback((key) => {
    const cur = phaseByKey.get(key);
    const next = phaseAfterFocus(cur);
    if (next === cur) return;
    phaseByKey.set(key, next);
    const id = keyToId.get(key);
    const info = id && sentRef.current.get(id);
    if (info) {
      postPhase(id, next, info);
      sentRef.current.set(id, { ...info, phase: next });
    }
    notifyPhases();
  }, []);

  const focusSession = useCallback((key, sessionId, machineId) => {
    acknowledgeDone(key);
    if (onFocusSession) onFocusSession(sessionId, machineId);
  }, [acknowledgeDone, onFocusSession]);

  // 从侧栏（而不是小镇）打开的终端：小镇在看终端时是卸载的，回来时 activeSession 就是用户
  // 刚才看着的那个会话，它的「干完了」提醒同样到此为止。
  const activeKey = activeSession ? sessionKey(activeSession) : null;
  useEffect(() => {
    if (activeKey) acknowledgeDone(activeKey);
  }, [activeKey, acknowledgeDone]);

  // 子系统发回来的动作。它原来是发给 VS Code 扩展宿主的（pixel-vscodeApi 把
  // vscode.postMessage 转成这个事件），移植后只有 focusAgent 被接住，其余**全部丢弃** ——
  // 于是「保存布局」是假的、关会话按钮点了没反应。这里按类型分流。
  useEffect(() => {
    function onPixelMessage(e) {
      const msg = e.detail;
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'focusAgent') {
        const target = idToSession.get(msg.id);
        if (target) focusSession(idToKey.get(msg.id), target.sessionId, target.machineId);
        return;
      }

      if (msg.type === 'saveLayout') {
        try {
          localStorage.setItem(LAYOUT_PREFIX + (machineRef.current || ''), JSON.stringify(msg.layout));
        } catch { /* 隐私模式/配额 */ }
        return;
      }

      if (msg.type === 'saveAgentSeats') {
        // 座位按**会话 key** 存，不是按数字 id：id 是本次浏览器会话里的自增值，
        // 刷新页面就重排了，用它存等于没存。
        const next = loadSavedSeats();
        for (const [rawId, seat] of Object.entries(msg.seats || {})) {
          const key = idToKey.get(Number(rawId));
          if (key) next[key] = seat;
        }
        saveSeatsByKey(next);
        return;
      }

      if (msg.type === 'closeAgent') {
        const target = idToSession.get(msg.id);
        if (target && onCloseSession) onCloseSession(target.machineId, target.sessionId);
        return;
      }

      // 导出/导入布局：原版是让 VS Code 宿主读写文件，在浏览器里就是下载/选文件。
      // 接上之后「设置」里这两项才不是摆设（布局是改了半天的东西，得能带走）。
      if (msg.type === 'exportLayout') {
        exportLayoutFile(machineRef.current || '');
        return;
      }
      if (msg.type === 'importLayout') {
        importLayoutFile((layout) => {
          // 连签名一起顶掉：不然下一轮发现「存档的签名对不上现在的目录结构」，
          // 刚导进来的布局立刻被自动生成的楼层顶回去。
          saveLayoutAndSig(machineRef.current || '', layout, sigRef.current || '');
          post({ type: 'layoutLoaded', layout });
        });
        return;
      }
    }
    window.addEventListener('pixel:postMessage', onPixelMessage);
    return () => window.removeEventListener('pixel:postMessage', onPixelMessage);
  }, [focusSession, onCloseSession]);

  // hook 事件只做「立刻改阶段」（点亮、干完了、卡在权限上），权威状态仍由 active_sessions
  // 兜底（2.5 秒一轮）。关键：hook 里的 sessionId 可能是 claude 的 UUID，与 tmux 会话名
  // 不是一个命名空间 —— 查不到已知会话就**丢掉**，绝不顺手造一个画布上不存在的小人。
  useEffect(() => {
    function onHookEvent(e) {
      const { hookEvent, sessionId, tmuxSession, machineId, notificationType } = e.detail || {};
      const key = sessionKeyOfHook(machineId, [sessionId, tmuxSession].filter(Boolean));
      if (!key) return;
      const cur = phaseByKey.get(key);
      const next = phaseFromHook(cur, { hookEvent, notificationType });
      if (!next || next === cur) return;
      phaseByKey.set(key, next);
      const id = keyToId.get(key);
      const info = id && sentRef.current.get(id);
      if (info) {
        postPhase(id, next, info);
        sentRef.current.set(id, { ...info, phase: next });
      }
      notifyPhases();
    }
    window.addEventListener('hook:event', onHookEvent);
    return () => window.removeEventListener('hook:event', onHookEvent);
  }, []);

  // 会话列表：所有机器的会话，要你动手的排最前
  const roster = sortRoster(activeSessions.filter((s) => s?.sessionId).map((s) => {
    const key = sessionKey(s);
    return {
      key,
      label: getRunningSessionTitle(s),
      machine: shortMachineId(s.machineId),
      tool: s.tool || 'claude',
      phase: phaseByKey.get(key) || (s.isRunning ? 'working' : 'idle'),
      offline: !!s.offline,
      onHere: !!house && townMachineKey(s) === house.key,
      sessionId: s.sessionId,
      machineId: s.machineId,
    };
  }));

  const tabBase = {
    display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0,
    padding: '3px 9px', fontSize: '0.72rem', lineHeight: 1.6,
    border: `1px solid ${T.border}`, borderRadius: 5, cursor: 'pointer',
    background: 'transparent', color: T.textSecondary, whiteSpace: 'nowrap',
  };

  return (
    <div className={PIXEL_SCOPE_CLASS} style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
      {/* 子系统整棵子树都在用 --pixel-* / --vscode-* 变量，而它们原来在这个应用里
          **一个都没有定义**（见 pixel-theme.js 顶部）。这里补齐并跟随本应用主题。 */}
      <style>{pixelThemeCss(T)}</style>

      {/* 一台开发机一个标签页。四台机器挤一张图 = 缩放只剩 1×、谁都看不清，
          所以这里是「选一台」而不是「全都画」。 */}
      <div
        data-testid="pixel-machine-tabs"
        style={{
          display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0,
          padding: '4px 6px', overflowX: 'auto', background: T.bgPanel,
          borderBottom: `1px solid ${T.border}`,
        }}
      >
        {houses.map((h) => {
          const selected = house && h.key === house.key;
          const count = sessionCountOf(h);
          const online = liveKeys.has(h.key);
          return (
            <button
              key={h.key}
              onClick={() => selectMachine(h.key)}
              title={`${h.title}${online ? '' : '（离线）'} · ${h.rooms.length} 个目录 · ${count} 个会话`}
              style={selected ? {
                ...tabBase,
                background: T.accentDim,
                borderColor: T.accent,
                color: T.textPrimary,
              } : tabBase}
            >
              <span style={{
                width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                background: online ? '#22c55e' : T.textMuted,
              }} />
              {h.label}
              <span style={{ color: T.textMuted, fontSize: '0.66rem' }}>{count}</span>
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', position: 'relative' }}>
        {/* 画布那块地方。stage 量的就是这个盒子 —— 它和 OfficeCanvas 的容器是同一个尺寸。 */}
        <div ref={stageRef} style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          {house ? <PixelApp /> : (
            <div style={{
              width: '100%', height: '100%', display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: T.textMuted, fontSize: '0.8rem',
            }}>还没有开发机连上来</div>
          )}
        </div>
        {/* 会话列表：宽屏占一条侧栏（不压地图，画布按剩下的宽度生成楼层），
            窄屏浮在画布右侧、默认收起 */}
        <SessionRoster
          entries={roster}
          open={rosterOpen}
          floating={narrow}
          onToggle={toggleRoster}
          onPick={(e) => focusSession(e.key, e.sessionId, e.machineId)}
        />
      </div>

      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0, fontSize: '0.6rem',
        color: T.textMuted, textAlign: 'center', padding: '2px', background: 'rgba(0,0,0,0.5)',
      }}>
        Pixel art inspired by{' '}
        <a href="https://github.com/georgetrad/pixel-agents" target="_blank" rel="noreferrer" style={{ color: T.accent }}>Pixel Agents</a>
        {' '}by Pablo De Lucca — MIT License
      </div>
    </div>
  );
}
