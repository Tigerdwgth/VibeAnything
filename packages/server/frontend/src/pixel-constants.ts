import type { FloorColor } from './office/types.js'

// ── Grid & Layout ────────────────────────────────────────────
export const TILE_SIZE = 16
export const DEFAULT_COLS = 20
export const DEFAULT_ROWS = 11
// 地图上限。原来是 64×64（上游只有一间固定办公室，够用），放宽到 96。
// 引擎本身不限尺寸（OfficeLayout 自带 cols/rows），这两个值只被编辑器的「扩一格」用，
// 以及楼层生成器用来给网格封顶（4K 屏 1× 格子会算出 240 列，见 townLayout.gridForZoom）。
export const MAX_COLS = 96
export const MAX_ROWS = 96

// ── 楼层生成（一台开发机 = 一个标签页里的一层楼，一个工作目录 = 一间房）─────
/** 一组「工位岛」坐几个人：2×2 的桌子四面各一把椅子 */
export const TOWN_SEATS_PER_ISLAND = 4
/** 工位岛连同四周椅子占的方块边长（格） */
export const TOWN_ISLAND_SPAN = 4
/** 相邻工位岛的间距（格）—— 比边长多 1，中间留一条能走的缝 */
export const TOWN_ISLAND_PITCH = 5
/** 房间顶部留给房间名牌的行数：工位从第二行起排，名牌才不会被小人的名牌顶掉 */
export const FLOOR_LABEL_ROWS = 1
/** 房间最小内部尺寸（格）= 一行名牌 + 一组工位岛，再小就坐不下人 */
export const FLOOR_MIN_ROOM_COLS = TOWN_ISLAND_SPAN + 2
export const FLOOR_MIN_ROOM_ROWS = TOWN_ISLAND_SPAN + FLOOR_LABEL_ROWS + 1
/** 一层楼最多几间房：再多房间名牌就挤成一片，多出来的目录并成「其他 N 个目录」 */
export const FLOOR_MAX_ROOMS = 16
/** 房间长宽比追求值（略扁一点，名牌写得下目录名） */
export const FLOOR_ROOM_ASPECT = 1.25
/** 工位留的余量：开一两个新会话不该把整层楼重排一次 */
export const FLOOR_SEAT_SLACK = 1.3
/**
 * 一间房摆几组工位岛，只能取这几个台阶值。
 * 工位数按会话数算（房间是铺满画布的分区，照面积摆满会出现一屋子空桌），
 * 但**不能精确跟着会话数走**：桌子一变，座位 uid 全变，整层楼就要重排一次。
 */
export const FLOOR_ISLAND_LADDER = [1, 2, 4, 6, 9, 12, 16, 20, 25, 30]
/**
 * 网格候选：**格子边长**（以 TILE_SIZE 为单位）从大到小试，取第一个放得下
 * 全部房间与工位的那档。格子越大，小人和名牌越看得清 —— 四台机器挤一张图
 * 然后整体缩到 1× 正是「太大，看不清」的由来。
 */
export const FLOOR_ZOOM_LADDER = [6, 5, 4, 3, 2, 1]
/** 还量不到画布尺寸时（首帧、jsdom 单测）用的网格 */
export const FLOOR_FALLBACK_COLS = 40
export const FLOOR_FALLBACK_ROWS = 26

// ── Character Animation ─────────────────────────────────────
export const WALK_SPEED_PX_PER_SEC = 48
export const WALK_FRAME_DURATION_SEC = 0.15
export const TYPE_FRAME_DURATION_SEC = 0.3
export const WANDER_PAUSE_MIN_SEC = 2.0
export const WANDER_PAUSE_MAX_SEC = 20.0
export const WANDER_MOVES_BEFORE_REST_MIN = 3
export const WANDER_MOVES_BEFORE_REST_MAX = 6
export const SEAT_REST_MIN_SEC = 120.0
export const SEAT_REST_MAX_SEC = 240.0

// ── Matrix Effect ────────────────────────────────────────────
export const MATRIX_EFFECT_DURATION_SEC = 0.3
export const MATRIX_TRAIL_LENGTH = 6
export const MATRIX_SPRITE_COLS = 16
export const MATRIX_SPRITE_ROWS = 24
export const MATRIX_FLICKER_FPS = 30
export const MATRIX_FLICKER_VISIBILITY_THRESHOLD = 180
export const MATRIX_COLUMN_STAGGER_RANGE = 0.3
export const MATRIX_HEAD_COLOR = '#ccffcc'
export const MATRIX_TRAIL_OVERLAY_ALPHA = 0.6
export const MATRIX_TRAIL_EMPTY_ALPHA = 0.5
export const MATRIX_TRAIL_MID_THRESHOLD = 0.33
export const MATRIX_TRAIL_DIM_THRESHOLD = 0.66

// ── Rendering ────────────────────────────────────────────────
export const CHARACTER_SITTING_OFFSET_PX = 6
export const CHARACTER_Z_SORT_OFFSET = 0.5
export const OUTLINE_Z_SORT_OFFSET = 0.001
export const SELECTED_OUTLINE_ALPHA = 1.0
export const HOVERED_OUTLINE_ALPHA = 0.5
export const GHOST_PREVIEW_SPRITE_ALPHA = 0.5
export const GHOST_PREVIEW_TINT_ALPHA = 0.25
export const SELECTION_DASH_PATTERN: [number, number] = [4, 3]
export const BUTTON_MIN_RADIUS = 6
export const BUTTON_RADIUS_ZOOM_FACTOR = 3
export const BUTTON_ICON_SIZE_FACTOR = 0.45
export const BUTTON_LINE_WIDTH_MIN = 1.5
export const BUTTON_LINE_WIDTH_ZOOM_FACTOR = 0.5
export const BUBBLE_FADE_DURATION_SEC = 0.5
export const BUBBLE_SITTING_OFFSET_PX = 10
export const BUBBLE_VERTICAL_OFFSET_PX = 24
export const FALLBACK_FLOOR_COLOR = '#808080'

// ── Rendering - Overlay Colors (canvas, not CSS) ─────────────
export const SEAT_OWN_COLOR = 'rgba(0, 127, 212, 0.35)'
export const SEAT_AVAILABLE_COLOR = 'rgba(0, 200, 80, 0.35)'
export const SEAT_BUSY_COLOR = 'rgba(220, 50, 50, 0.35)'
export const GRID_LINE_COLOR = 'rgba(255,255,255,0.12)'
export const VOID_TILE_OUTLINE_COLOR = 'rgba(255,255,255,0.08)'
export const VOID_TILE_DASH_PATTERN: [number, number] = [2, 2]
export const GHOST_BORDER_HOVER_FILL = 'rgba(60, 130, 220, 0.25)'
export const GHOST_BORDER_HOVER_STROKE = 'rgba(60, 130, 220, 0.5)'
export const GHOST_BORDER_STROKE = 'rgba(255, 255, 255, 0.06)'
export const GHOST_VALID_TINT = '#00ff00'
export const GHOST_INVALID_TINT = '#ff0000'
export const SELECTION_HIGHLIGHT_COLOR = '#007fd4'
export const DELETE_BUTTON_BG = 'rgba(200, 50, 50, 0.85)'
export const ROTATE_BUTTON_BG = 'rgba(50, 120, 200, 0.85)'

// ── Camera ───────────────────────────────────────────────────
// 回座位的路算不出来时，隔多久再试一次（秒）。寻路是全图 BFS，不能每帧来一遍。
export const REPATH_RETRY_SEC = 0.5

export const CAMERA_FOLLOW_LERP = 0.1
export const CAMERA_FOLLOW_SNAP_THRESHOLD = 0.5

// ── Zoom ─────────────────────────────────────────────────────
export const ZOOM_MIN = 1
export const ZOOM_MAX = 10
export const ZOOM_DEFAULT_DPR_FACTOR = 2
export const ZOOM_LEVEL_FADE_DELAY_MS = 1500
export const ZOOM_LEVEL_HIDE_DELAY_MS = 2000
export const ZOOM_LEVEL_FADE_DURATION_SEC = 0.5
export const ZOOM_SCROLL_THRESHOLD = 50
export const PAN_MARGIN_FRACTION = 0.25

// ── Editor ───────────────────────────────────────────────────
export const UNDO_STACK_MAX_SIZE = 50
export const LAYOUT_SAVE_DEBOUNCE_MS = 500
export const DEFAULT_FLOOR_COLOR: FloorColor = { h: 35, s: 30, b: 15, c: 0 }
export const DEFAULT_WALL_COLOR: FloorColor = { h: 240, s: 25, b: 0, c: 0 }
export const DEFAULT_NEUTRAL_COLOR: FloorColor = { h: 0, s: 0, b: 0, c: 0 }

// ── Notification Sound ──────────────────────────────────────
export const NOTIFICATION_NOTE_1_HZ = 659.25   // E5
export const NOTIFICATION_NOTE_2_HZ = 1318.51  // E6 (octave up)
export const NOTIFICATION_NOTE_1_START_SEC = 0
export const NOTIFICATION_NOTE_2_START_SEC = 0.1
export const NOTIFICATION_NOTE_DURATION_SEC = 0.18
export const NOTIFICATION_VOLUME = 0.14

// ── Game Logic ───────────────────────────────────────────────
export const MAX_DELTA_TIME_SEC = 0.1
export const WAITING_BUBBLE_DURATION_SEC = 2.0
export const DISMISS_BUBBLE_FAST_FADE_SEC = 0.3
export const INACTIVE_SEAT_TIMER_MIN_SEC = 3.0
export const INACTIVE_SEAT_TIMER_RANGE_SEC = 2.0
export const PALETTE_COUNT = 6
export const HUE_SHIFT_MIN_DEG = 45
export const HUE_SHIFT_RANGE_DEG = 271
export const AUTO_ON_FACING_DEPTH = 3
export const AUTO_ON_SIDE_DEPTH = 2
export const CHARACTER_HIT_HALF_WIDTH = 8
export const CHARACTER_HIT_HEIGHT = 24
export const TOOL_OVERLAY_VERTICAL_OFFSET = 32
export const PULSE_ANIMATION_DURATION_SEC = 1.5
