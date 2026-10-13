/**
 * 把「开发机 / 分类文件夹 / 会话」这套真实结构画成一层办公楼平面图：
 *
 *   一台开发机 = 一个标签页里的一整层楼（整块画布就是这层楼）
 *   一个 VibeAnything 分类文件夹 = 楼里的一间房（子文件夹独立成房）
 *   一个会话 = 房间里的一个工位
 *
 * 为什么是「一台机器一个标签页」而不是四台机器一张图（2026-10-10 改）：
 * 四台机器各三四个目录要 45×36 格，而画布只有 1360×957，缩放是取整的
 * （`toolUtils.fitZoom` → `Math.floor`），算下来只有 1× —— 整座小镇缩在屏幕中间
 * 一半的面积里、小人只有 16 像素高，于是「全都显示在一页上，太大，看不清」。
 * 现在反过来做：**先量画布，再按画布生成正好铺满它的网格**（gridForZoom），
 * 一层楼只装一台机器，格子边长优先取大的那档（FLOOR_ZOOM_LADDER）。
 *
 * 三个入口分开是故意的：
 *   · buildTownSpec()      会话 + 机器列表 → 「有哪些机器、各自有哪些分类文件夹」（标签页也用它）
 *   · planFloor()          只算几何与座位表，不碰上千个瓦片 —— 集成层**每轮**都要用它
 *                          来判断「谁该坐哪」，不能每 2.5 秒就重建一次地图
 *   · emitFloorLayout()    才真正生成 OfficeLayout（瓦片/颜色/家具/门/名牌区域），
 *                          只在这层楼的构成（签名）变了时调一次
 *
 * 签名里**只有**机器、房间键和网格尺寸，**没有会话数** —— 开关会话不会重排楼层，
 * 新来的人自己走到一个空工位上坐下；新建/删掉一个分类文件夹（= 一间房）才重排。
 */

import { buildSessionTree, flattenFolderPaths } from '../../folder-tree.js'

import { TileType, FurnitureType } from '../types.js'
import type {
  TileType as TileTypeVal,
  OfficeLayout,
  PlacedFurniture,
  FloorColor,
  TownPlace,
} from '../types.js'
import {
  TILE_SIZE,
  MAX_COLS,
  MAX_ROWS,
  TOWN_ISLAND_SPAN,
  TOWN_ISLAND_PITCH,
  FLOOR_LABEL_ROWS,
  FLOOR_MIN_ROOM_COLS,
  FLOOR_MIN_ROOM_ROWS,
  FLOOR_MAX_ROOMS,
  FLOOR_ROOM_ASPECT,
  FLOOR_SEAT_SLACK,
  FLOOR_ISLAND_LADDER,
  FLOOR_ZOOM_LADDER,
  FLOOR_FALLBACK_COLS,
  FLOOR_FALLBACK_ROWS,
} from '../../pixel-constants.js'

// ── 输入 ────────────────────────────────────────────────────────

export interface TownSessionLike {
  machineId?: string | null
  sessionId: string
  cwd?: string | null
  folderId?: string | null
}

export interface TownMachineLike {
  machineId: string
  defaultWorkDir?: string
}

export interface TownFolderLike {
  id: string
  name: string
  parentId?: string | null
}

export interface TownRoomSpec {
  /** 稳定键 `${machineId}|folder:${folderId}` —— 座位 uid 就是从它派生的，不能用下标 */
  key: string
  label: string
  /** 分类层级路径（名牌悬停显示）；合并房与空房可能为空 */
  path: string
  /** 这间房里的会话 key（`machineId::sessionId`），已排序 */
  sessionKeys: string[]
}

export interface TownHouseSpec {
  /** 稳定键 = machineId */
  key: string
  label: string
  title: string
  rooms: TownRoomSpec[]
}

// ── 规划结果 ────────────────────────────────────────────────────

export interface PlannedRoom extends TownRoomSpec {
  /** 房间内部范围（不含墙） */
  col: number
  row: number
  cols: number
  rows: number
  /** 工位岛阵列 */
  islandCols: number
  islandRows: number
  /** 工位岛左上角（内部坐标） */
  islandCol: number
  islandRow: number
  /** 这间房的全部座位 uid，顺序稳定 */
  seats: string[]
  /** 这间房在第几带（门就开在带内相邻房之间、带与带之间） */
  band: number
  /** 为了塞进这层楼被合并掉的目录数（0 = 没合并） */
  mergedDirs: number
}

export interface FloorGrid {
  cols: number
  rows: number
}

export interface FloorPlan {
  /** = machineId */
  machineKey: string
  label: string
  title: string
  /** 这台机器的色相（地板/墙都用它，换标签页一眼看出换了机器） */
  hue: number
  cols: number
  rows: number
  /** 每一带几间房 */
  bands: number[]
  rooms: PlannedRoom[]
  /** 会话 key → 座位 uid（工位不够时个别会话没有） */
  seatOfSession: Record<string, string>
  /** 房间 key → 全部座位 uid */
  seatsByRoom: Record<string, string[]>
  /** 没分到工位的会话数：选网格那档时就是靠它判断「这档坐不坐得下」 */
  unseated: number
  /** 被合并进「其他 N 个分类」的目录数 */
  mergedDirs: number
  /** 这层楼的指纹：机器 + 房间键 + 网格尺寸，**不含**会话数 */
  signature: string
}

// ── 工具 ────────────────────────────────────────────────────────

export const townMachineKey = (s: { machineId?: string | null }): string => s.machineId || 'local'
export const townSessionKey = (s: TownSessionLike): string => `${townMachineKey(s)}::${s.sessionId}`
export const townRoomKey = (machineKey: string, path: string): string => `${machineKey}|${path}`

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100003
  return h
}

/** 机器短名：剥掉 DNS 域。与侧栏的 machine-name.js 同一条规则（那边是 JS，这里不跨层 import） */
function shortMachine(machineId: string): string {
  const dot = machineId.indexOf('.')
  return dot > 0 ? machineId.slice(0, dot) : machineId
}

/** 字典序比较：排在前面的指标优先，完全相同算「不更好」（保住先遇到的那个） */
function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i]
  return false
}

/** 把 total 分成 n 份，整数、尽量平均，多出来的给前面几份 */
function split(total: number, n: number): number[] {
  if (n <= 0) return []
  const base = Math.floor(total / n)
  const extra = total - base * n
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0))
}

/**
 * 按权重分 total，每份不少于 minEach，余数按小数部分从大到小发（结果稳定）。
 *
 * 房间宽度按「要摆几组工位」来分，不是平分：平分的话 1 个会话的目录和 22 个会话的
 * 目录各占半屏，一边空着一边挤。权重取的是**台阶化**过的工位组数（见 islandsNeeded），
 * 所以多开一两个会话不会改变宽度 —— 改变宽度的那一刻本来就要重建楼层。
 */
function splitWeighted(total: number, weights: number[], minEach: number): number[] {
  const n = weights.length
  if (n === 0) return []
  if (total <= minEach * n) return split(total, n)
  const extra = total - minEach * n
  const sum = weights.reduce((a, b) => a + b, 0) || n
  const raw = weights.map((w) => (extra * w) / sum)
  const out = raw.map((v) => minEach + Math.floor(v))
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
  let left = total - out.reduce((a, b) => a + b, 0)
  for (let k = 0; left > 0; k++, left--) out[order[k % n].i]++
  return out
}

// ── 第一步：从会话与机器列表得出「有哪些机器、各自有哪些分类文件夹」 ────────

/**
 * 分组规则：机器 → VibeAnything 分类文件夹。机器列表里没有会话的机器也留一个标签页（楼里一间空房），
 * 否则最后一个会话关掉时整台机器凭空消失，标签页一天换好几次。
 */
export function buildTownSpec(
  sessions: TownSessionLike[],
  machines: TownMachineLike[] = [],
  foldersByMachine: Record<string, TownFolderLike[]> = {},
): TownHouseSpec[] {
  const byMachine = new Map<string, TownSessionLike[]>()
  for (const m of machines) if (m?.machineId) byMachine.set(m.machineId, [])
  for (const session of sessions) {
    if (!session?.sessionId) continue
    const key = townMachineKey(session)
    if (!byMachine.has(key)) byMachine.set(key, [])
    byMachine.get(key)!.push(session)
  }
  return [...byMachine.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, members]) => {
    const folders = foldersByMachine[key] || []
    const { rootFolders, rootSessions } = buildSessionTree(folders, members)
    const paths = new Map(flattenFolderPaths(folders).map(f => [f.id, f.label]))
    const rooms: TownRoomSpec[] = []
    const visit = (nodes: typeof rootFolders) => {
      for (const node of nodes) {
        rooms.push({
          key: townRoomKey(key, `folder:${node.id}`),
          label: paths.get(node.id) || node.name,
          path: paths.get(node.id) || node.name,
          sessionKeys: node.sessions.map(townSessionKey).sort(),
        })
        visit(node.children)
      }
    }
    visit(rootFolders)
    if (rootSessions.length || !rooms.length) rooms.push({
      key: townRoomKey(key, 'root'), label: '未分类', path: '未分类',
      sessionKeys: rootSessions.map(townSessionKey).sort(),
    })
    return { key, label: shortMachine(key), title: key, rooms }
  })
}

// ── 第二步：选网格（正好铺满画布）────────────────────────────────

/**
 * 画布（**设备像素**）+ 格子边长倍数 → 正好铺满它的网格。
 *
 * 这是整件事的关键：网格是按画布算出来的，所以
 * `cols * TILE_SIZE * zoom ≤ 画布宽 < (cols+1) * TILE_SIZE * zoom`，
 * 画布那边的 fitZoom 会原样挑回这个 zoom，于是地图铺满画布（误差不到一格）。
 */
export function gridForZoom(stage: { width: number; height: number }, zoom: number): FloorGrid {
  const unit = TILE_SIZE * Math.max(1, zoom)
  const cols = Math.floor((stage.width || 0) / unit)
  const rows = Math.floor((stage.height || 0) / unit)
  if (cols < 3 || rows < 3) return { cols: FLOOR_FALLBACK_COLS, rows: FLOOR_FALLBACK_ROWS }
  return { cols: Math.min(cols, MAX_COLS), rows: Math.min(rows, MAX_ROWS) }
}

// ── 第三步：几何规划（房间分区、工位、座位表）────────────────────

/** 一组工位岛里四把椅子的位置与座位后缀。桌子是 2×2，四面各一把椅子。 */
const ISLAND_CHAIRS: Array<{ dc: number; dr: number; tag: string }> = [
  { dc: 1, dr: 0, tag: 'n' },  // 桌子在下方 → 朝下坐
  { dc: 0, dr: 1, tag: 'w' },  // 桌子在右方 → 朝右坐
  { dc: TOWN_ISLAND_SPAN - 1, dr: 2, tag: 'e' },
  { dc: 2, dr: TOWN_ISLAND_SPAN - 1, tag: 's' },
]

/** 座位 uid 按**内容**派生（房间键 + 岛号 + 方位），不用下标：
 *  机器上下线会让下标整体错位，而座位要记在 localStorage 里跨会话复用。 */
function seatUid(roomKey: string, island: number, tag: string): string {
  return `c:${roomKey}:${island}${tag}`
}

/** 一条边上能放几组工位岛：k 组占 SPAN*k + (k-1) 格 */
function islandsAcross(span: number): number {
  return Math.max(0, Math.floor((span + 1) / TOWN_ISLAND_PITCH))
}

/**
 * 这间房要摆几组工位岛。**按会话数算，不按房间大小算** ——
 * 房间是按分区铺满画布的（一台机器一层楼，房间自然很大），要是把能放的位置全摆满，
 * 一个会话的房间里会出现十五张空桌子。
 *
 * 数量取**台阶值**而不是精确值：开一两个会话不该改变桌子数，
 * 否则桌子一动整层楼的座位 uid 就全变了（= 全楼重排、所有人瞬移）。
 */
function islandsNeeded(sessionCount: number): number {
  const want = Math.ceil((sessionCount * FLOOR_SEAT_SLACK) / ISLAND_CHAIRS.length)
  for (const step of FLOOR_ISLAND_LADDER) if (step >= want) return step
  return FLOOR_ISLAND_LADDER[FLOOR_ISLAND_LADDER.length - 1]
}

/** 把 n 组工位岛排成尽量方的阵列，排不下就按能放下的来 */
function islandGrid(n: number, fitCols: number, fitRows: number): { cols: number; rows: number } {
  if (fitCols <= 0 || fitRows <= 0) return { cols: 0, rows: 0 }
  const capped = Math.min(n, fitCols * fitRows)
  let best: { cols: number; rows: number; score: number } | null = null
  for (let cols = 1; cols <= fitCols; cols++) {
    const rows = Math.ceil(capped / cols)
    if (rows > fitRows) continue
    const score = Math.abs(Math.log(cols / rows / FLOOR_ROOM_ASPECT))
    if (!best || score < best.score) best = { cols, rows, score }
  }
  return best ? { cols: best.cols, rows: best.rows } : { cols: fitCols, rows: fitRows }
}

/** 房间多到放不下时，留下会话最多的几间，其余并成一间「其他 N 个分类」 */
function capRooms(rooms: TownRoomSpec[], maxRooms: number, machineKey: string): { rooms: TownRoomSpec[]; mergedDirs: number } {
  if (rooms.length <= maxRooms) return { rooms: [...rooms], mergedDirs: 0 }
  const ranked = [...rooms].sort(
    (a, b) => b.sessionKeys.length - a.sessionKeys.length || a.path.localeCompare(b.path),
  )
  const keep = ranked.slice(0, Math.max(1, maxRooms - 1))
  const rest = ranked.slice(Math.max(1, maxRooms - 1))
  const merged: TownRoomSpec = {
    key: townRoomKey(machineKey, '__more__'),
    label: `其他 ${rest.length} 个分类`,
    path: rest.map((r) => r.path).join('\n'),
    sessionKeys: rest.flatMap((r) => r.sessionKeys).sort((a, b) => a.localeCompare(b)),
  }
  return {
    rooms: [...keep.sort((a, b) => a.path.localeCompare(b.path)), merged],
    mergedDirs: rest.length,
  }
}

/**
 * 选「分几带、每带几间」：带内横向排房，带与带之间一道横墙。
 * 候选里挑房间长宽比最接近 FLOOR_ROOM_ASPECT 的那个 —— 否则房间会摊成长条，
 * 工位岛排不满、名牌也写不下。
 */
function chooseBands(rooms: TownRoomSpec[], innerW: number, innerH: number): number[] {
  const n = rooms.length
  const maxPerBand = Math.max(1, Math.floor((innerW + 1) / (FLOOR_MIN_ROOM_COLS + 1)))
  const maxBands = Math.max(1, Math.floor((innerH + 1) / (FLOOR_MIN_ROOM_ROWS + 1)))
  let best: { bands: number[]; score: number } | null = null
  for (let b = 1; b <= Math.min(maxBands, n); b++) {
    const bands = split(n, b)
    if (bands[0] > maxPerBand) continue
    const heights = split(innerH - (b - 1), b)
    let score = 0
    let cursor = 0
    bands.forEach((count, i) => {
      const widths = bandWidths(rooms.slice(cursor, cursor + count), innerW)
      cursor += count
      for (const w of widths) score += Math.abs(Math.log(w / heights[i] / FLOOR_ROOM_ASPECT))
    })
    score /= n
    if (!best || score < best.score) best = { bands, score }
  }
  // 一间都排不下（画布极小）时退回「一带装满」，房间会小于最小尺寸，
  // 由上层的网格阶梯换一档更小的格子来兜。
  return best ? best.bands : split(n, Math.max(1, Math.ceil(n / maxPerBand)))
}

/** 一带里各房间的宽度：按「要摆几组工位」分，人多的目录给大屋 */
function bandWidths(rooms: TownRoomSpec[], innerW: number): number[] {
  return splitWeighted(
    innerW - (rooms.length - 1),
    rooms.map((r) => islandsNeeded(r.sessionKeys.length)),
    FLOOR_MIN_ROOM_COLS,
  )
}

/** 按「带」把房间铺满整层楼的内部：每间房的 col/row/cols/rows 在这里定下来 */
function layoutRooms(rooms: TownRoomSpec[], grid: FloorGrid, mergedDirs: number): { rooms: PlannedRoom[]; bands: number[] } {
  const innerW = grid.cols - 2
  const innerH = grid.rows - 2
  const bands = chooseBands(rooms, innerW, innerH)
  const heights = split(innerH - (bands.length - 1), bands.length)
  const out: PlannedRoom[] = []
  let cursor = 0
  let row = 1
  bands.forEach((count, bandIdx) => {
    const widths = bandWidths(rooms.slice(cursor, cursor + count), innerW)
    let col = 1
    for (let i = 0; i < count; i++) {
      const spec = rooms[cursor++]
      if (!spec) break
      out.push(planOneRoom(spec, col, row, widths[i], heights[bandIdx], bandIdx, mergedDirs))
      col += widths[i] + 1
    }
    row += heights[bandIdx] + 1
  })
  return { rooms: out, bands }
}

/** 一间房：顶上一行留给房间名牌，剩下的面积排满工位岛，座位 uid 随之定下 */
function planOneRoom(
  spec: TownRoomSpec,
  col: number,
  row: number,
  cols: number,
  rows: number,
  band: number,
  mergedDirs: number,
): PlannedRoom {
  const usableRows = rows - FLOOR_LABEL_ROWS
  const { cols: islandCols, rows: islandRows } = islandGrid(
    islandsNeeded(spec.sessionKeys.length),
    islandsAcross(cols),
    islandsAcross(usableRows),
  )
  const usedW = islandCols > 0 ? TOWN_ISLAND_PITCH * islandCols - 1 : 0
  const usedH = islandRows > 0 ? TOWN_ISLAND_PITCH * islandRows - 1 : 0
  const islandCol = col + Math.floor((cols - usedW) / 2)
  const islandRow = row + FLOOR_LABEL_ROWS + Math.floor((usableRows - usedH) / 2)
  const seats: string[] = []
  for (let i = 0; i < islandCols * islandRows; i++) {
    for (const chair of ISLAND_CHAIRS) seats.push(seatUid(spec.key, i, chair.tag))
  }
  return {
    ...spec,
    col,
    row,
    cols,
    rows,
    islandCols,
    islandRows,
    islandCol,
    islandRow,
    seats,
    band,
    mergedDirs: spec.key.endsWith('|__more__') ? mergedDirs : 0,
  }
}

/**
 * 谁坐哪。先满足「上次坐哪这次还坐哪」，但只认**本房间内**的座位：
 * 会话换了分类文件夹就得换房间，老座位不能把人留在原来那间屋里。
 */
function planSeats(
  rooms: PlannedRoom[],
  preferredSeats?: Record<string, string>,
): { seatOfSession: Record<string, string>; seatsByRoom: Record<string, string[]>; unseated: number } {
  const seatOfSession: Record<string, string> = {}
  const seatsByRoom: Record<string, string[]> = {}
  let unseated = 0
  for (const room of rooms) {
    seatsByRoom[room.key] = room.seats
    const free = new Set(room.seats)
    const taken = new Map<string, string>()
    for (const sk of room.sessionKeys) {
      const want = preferredSeats?.[sk]
      if (want && free.has(want)) {
        free.delete(want)
        taken.set(sk, want)
      }
    }
    const rest = room.seats.filter((s) => free.has(s))
    let i = 0
    for (const sk of room.sessionKeys) {
      if (taken.has(sk)) continue
      if (i < rest.length) taken.set(sk, rest[i++])
      else unseated++
    }
    for (const [sk, seat] of taken) seatOfSession[sk] = seat
  }
  return { seatOfSession, seatsByRoom, unseated }
}

/**
 * 签名：机器 + 网格尺寸 + 每间房的（房间键 + 工位阵列）。
 * **会话数不进签名** —— 开关会话不重排楼层；只有分类增删或改名、画布尺寸变化、
 * 或者某间房的会话数跨过了工位台阶（桌子真的要多摆一排）才重建。
 */
function signatureOf(machineKey: string, rooms: PlannedRoom[], grid: FloorGrid): string {
  const body = rooms.map((r) => JSON.stringify([r.key, r.label, r.path, r.islandCols, r.islandRows])).join(',')
  return `f1|${machineKey}|${grid.cols}x${grid.rows}|${body}`
}

/**
 * 只算几何与座位，不生成瓦片。集成层每轮都调它（判断谁该坐哪、签名有没有变）。
 */
export function planFloor(
  spec: TownHouseSpec,
  grid: FloorGrid,
  opts: { preferredSeats?: Record<string, string> } = {},
): FloorPlan {
  const innerW = grid.cols - 2
  const innerH = grid.rows - 2
  const maxPerBand = Math.max(1, Math.floor((innerW + 1) / (FLOOR_MIN_ROOM_COLS + 1)))
  const maxBands = Math.max(1, Math.floor((innerH + 1) / (FLOOR_MIN_ROOM_ROWS + 1)))
  // 一间房都没有（机器在线、没会话也没分类）时给一间空房：
  // 否则这层楼就是一屏实心墙，看着像坏了
  const specRooms: TownRoomSpec[] = spec.rooms.length
    ? spec.rooms
    : [{ key: townRoomKey(spec.key, ''), label: '空房间', path: '', sessionKeys: [] }]
  const capped = capRooms(specRooms, Math.min(FLOOR_MAX_ROOMS, maxPerBand * maxBands), spec.key)
  const { rooms, bands } = layoutRooms(capped.rooms, grid, capped.mergedDirs)
  const { seatOfSession, seatsByRoom, unseated } = planSeats(rooms, opts.preferredSeats)
  return {
    machineKey: spec.key,
    label: spec.label,
    title: spec.title,
    hue: hashString(spec.key) % 360,
    cols: grid.cols,
    rows: grid.rows,
    bands,
    rooms,
    seatOfSession,
    seatsByRoom,
    unseated,
    mergedDirs: capped.mergedDirs,
    signature: signatureOf(spec.key, rooms, grid),
  }
}

/**
 * 选一档网格并规划这层楼：格子**从大到小**试，取第一个「房间都不小于最小尺寸、
 * 每间房的工位都够坐（还留 FLOOR_SEAT_SLACK 的余量）」的那档。
 *
 * 留余量是为了别一开会话就重排整层楼：工位刚好坐满时再来一个人就得换档，
 * 而换档 = 网格变 = 签名变 = 全楼重建。
 */
export function buildFloorPlan(
  spec: TownHouseSpec,
  stage: { width: number; height: number },
  opts: { preferredSeats?: Record<string, string> } = {},
): { plan: FloorPlan; grid: FloorGrid; zoom: number } {
  let fallback: { plan: FloorPlan; grid: FloorGrid; zoom: number; score: number[] } | null = null
  for (const zoom of FLOOR_ZOOM_LADDER) {
    const grid = gridForZoom(stage, zoom)
    const plan = planFloor(spec, grid, opts)
    const sizesOk = plan.rooms.every((r) => r.cols >= FLOOR_MIN_ROOM_COLS && r.rows >= FLOOR_MIN_ROOM_ROWS)
    const seatsOk = plan.rooms.every(
      (r) => r.seats.length >= Math.ceil(r.sessionKeys.length * FLOOR_SEAT_SLACK),
    )
    // 合格 = 房间都够大、每个分类都有自己的房间（一个都没合并）、人人有座
    if (sizesOk && seatsOk && plan.mergedDirs === 0) return { plan, grid, zoom }
    // 一路到 1× 都不合格时的退路：先比「少合并目录」，再比「少几个人没座」，
    // 再比「房间尺寸合法」；都一样就留着先遇到的那个（格子更大，看得更清）。
    const score = [plan.mergedDirs, plan.unseated, sizesOk ? 0 : 1]
    if (!fallback || lexLess(score, fallback.score)) fallback = { plan, grid, zoom, score }
  }
  return fallback!
}

// ── 第四步：生成瓦片 / 颜色 / 家具 / 门 / 名牌区域 ──────────────────

/** 门口的地板 */
const DOORWAY_COLOR: FloorColor = { h: 32, s: 32, b: 6, c: 0 }

const roomFloorColor = (hue: number, idx: number): FloorColor => ({
  // 相邻房间换个色相 + 明暗交替：差别太小的话，一层楼里几间房看着是连通的一大片
  h: (hue + (idx % 3) * 14) % 360,
  s: 24,
  b: idx % 2 === 0 ? -8 : 7,
  c: 0,
})
const wallColor = (hue: number): FloorColor => ({ h: hue, s: 30, b: -14, c: 0 })

interface EmitCtx {
  tiles: TileTypeVal[]
  colors: Array<FloorColor | null>
  cols: number
  rows: number
  furniture: PlacedFurniture[]
  places: TownPlace[]
  /** 被家具占住的格子（门不能开在它旁边，否则门后是堵死的） */
  blocked: Set<string>
}

function put(ctx: EmitCtx, col: number, row: number, tile: TileTypeVal, color: FloorColor | null): void {
  if (col < 0 || row < 0 || col >= ctx.cols || row >= ctx.rows) return
  const idx = row * ctx.cols + col
  ctx.tiles[idx] = tile
  ctx.colors[idx] = color
}

const tileAt = (ctx: EmitCtx, col: number, row: number): TileTypeVal | null =>
  col < 0 || row < 0 || col >= ctx.cols || row >= ctx.rows ? null : ctx.tiles[row * ctx.cols + col]

/** 这格现在是「能站人的空地板」吗（门的两侧必须都是） */
function isOpenFloor(ctx: EmitCtx, col: number, row: number): boolean {
  const t = tileAt(ctx, col, row)
  if (t === null || t === TileType.WALL || t === TileType.VOID) return false
  return !ctx.blocked.has(`${col},${row}`)
}

function addFurniture(ctx: EmitCtx, item: PlacedFurniture, w = 1, h = 1): void {
  ctx.furniture.push(item)
  for (let dr = 0; dr < h; dr++) {
    for (let dc = 0; dc < w; dc++) ctx.blocked.add(`${item.col + dc},${item.row + dr}`)
  }
}

/** 一组工位岛的桌椅。椅子朝向由 layoutToSeats 按「相邻的桌子在哪边」算出来。 */
function emitIsland(ctx: EmitCtx, room: PlannedRoom, island: number, ox: number, oy: number): void {
  addFurniture(ctx, { uid: `d:${room.key}:${island}`, type: FurnitureType.DESK, col: ox + 1, row: oy + 1 }, 2, 2)
  for (const chair of ISLAND_CHAIRS) {
    addFurniture(ctx, {
      uid: seatUid(room.key, island, chair.tag),
      type: FurnitureType.CHAIR,
      col: ox + chair.dc,
      row: oy + chair.dr,
    })
  }
}

/** 一间房：地板 + 工位岛 + 一点摆设 + 名牌区域（门最后统一开，见 carveDoors） */
function emitRoom(ctx: EmitCtx, plan: FloorPlan, room: PlannedRoom, idx: number): void {
  const floor = roomFloorColor(plan.hue, idx)
  for (let r = 0; r < room.rows; r++) {
    for (let c = 0; c < room.cols; c++) put(ctx, room.col + c, room.row + r, TileType.FLOOR_1, floor)
  }

  for (let ir = 0; ir < room.islandRows; ir++) {
    for (let ic = 0; ic < room.islandCols; ic++) {
      emitIsland(
        ctx,
        room,
        ir * room.islandCols + ic,
        room.islandCol + ic * TOWN_ISLAND_PITCH,
        room.islandRow + ir * TOWN_ISLAND_PITCH,
      )
    }
  }

  // 摆设放在四角的空地上（桌子按需摆，房间会有余量）。只放还空着的格子上，
  // 并且放完就进 blocked —— 门的位置是最后挑的，不能挑到盆栽后面去。
  const corners: Array<[number, number]> = [
    [room.col, room.row + room.rows - 1],
    [room.col + room.cols - 1, room.row + room.rows - 1],
    [room.col, room.row + FLOOR_LABEL_ROWS],
    [room.col + room.cols - 1, room.row + FLOOR_LABEL_ROWS],
  ]
  corners.forEach(([c, r], i) => {
    if (isOpenFloor(ctx, c, r)) {
      addFurniture(ctx, { uid: `p:${room.key}:${i}`, type: FurnitureType.PLANT, col: c, row: r })
    }
  })

  ctx.places.push({
    kind: 'room',
    key: room.key,
    label: room.label,
    title: room.path || room.label,
    houseKey: plan.machineKey,
    col: room.col,
    row: room.row,
    cols: room.cols,
    rows: room.rows,
  })
}

/**
 * 开门。所有房间必须连通：寻路是全图 BFS，被封死的人每隔半秒白跑一次全图，
 * 而且一旦被挪出房间就再也回不去。
 *   · 带内相邻两间房 → 中间那道竖墙上开一扇
 *   · 带与带之间     → 那道横墙上尽量每间房下面开一扇（一扇就够连通，多开只是好看）
 * 门的两侧都必须是空地板：椅子和桌子都算阻挡，开在它们旁边等于没开。
 */
function carveDoors(ctx: EmitCtx, plan: FloorPlan): void {
  const openDoor = (col: number, row: number) => put(ctx, col, row, TileType.FLOOR_4, DOORWAY_COLOR)
  /** 从中间往两边找一个两侧都通的位置 */
  const pick = (from: number, to: number, ok: (v: number) => boolean): number | null => {
    const mid = Math.floor((from + to) / 2)
    for (let d = 0; d <= to - from; d++) {
      for (const v of d === 0 ? [mid] : [mid - d, mid + d]) {
        if (v >= from && v <= to && ok(v)) return v
      }
    }
    return null
  }

  const byBand = new Map<number, PlannedRoom[]>()
  for (const room of plan.rooms) {
    const list = byBand.get(room.band)
    if (list) list.push(room)
    else byBand.set(room.band, [room])
  }

  // 带内：相邻房之间
  for (const rooms of byBand.values()) {
    for (let i = 0; i + 1 < rooms.length; i++) {
      const left = rooms[i]
      const wall = left.col + left.cols
      const row = pick(left.row, left.row + left.rows - 1, (r) =>
        isOpenFloor(ctx, wall - 1, r) && isOpenFloor(ctx, wall + 1, r))
      if (row !== null) openDoor(wall, row)
    }
  }

  // 带与带之间
  const bandIdx = [...byBand.keys()].sort((a, b) => a - b)
  for (let i = 0; i + 1 < bandIdx.length; i++) {
    const upper = byBand.get(bandIdx[i])!
    const wall = upper[0].row + upper[0].rows
    let opened = 0
    for (const room of upper) {
      const col = pick(room.col, room.col + room.cols - 1, (c) =>
        isOpenFloor(ctx, c, wall - 1) && isOpenFloor(ctx, c, wall + 1))
      if (col !== null) { openDoor(col, wall); opened++ }
    }
    if (opened === 0) {
      // 上面一排房都没合适的位置（极窄的楼层）：整条墙上找一处，连通性不能丢
      const col = pick(1, ctx.cols - 2, (c) => isOpenFloor(ctx, c, wall - 1) && isOpenFloor(ctx, c, wall + 1))
      if (col !== null) openDoor(col, wall)
    }
  }
}

/** 把规划结果变成引擎认的 OfficeLayout。只在这层楼的构成变了时调一次。 */
export function emitFloorLayout(plan: FloorPlan): OfficeLayout {
  const { cols, rows } = plan
  const n = cols * rows
  const wall = wallColor(plan.hue)
  const ctx: EmitCtx = {
    tiles: new Array<TileTypeVal>(n).fill(TileType.WALL),
    colors: new Array<FloorColor | null>(n).fill(wall),
    cols,
    rows,
    furniture: [],
    places: [],
    blocked: new Set<string>(),
  }
  plan.rooms.forEach((room, idx) => emitRoom(ctx, plan, room, idx))
  carveDoors(ctx, plan)
  return {
    version: 1,
    cols,
    rows,
    tiles: ctx.tiles,
    tileColors: ctx.colors,
    furniture: ctx.furniture,
    places: ctx.places,
  }
}

/** 一步到底：一台机器的结构 + 画布尺寸 → 这层楼（规划 + 生成）。供测试与一次性重建用。 */
export function buildFloor(
  spec: TownHouseSpec,
  stage: { width: number; height: number },
  opts: { preferredSeats?: Record<string, string> } = {},
): { plan: FloorPlan; layout: OfficeLayout; zoom: number } {
  const { plan, zoom } = buildFloorPlan(spec, stage, opts)
  return { plan, layout: emitFloorLayout(plan), zoom }
}
