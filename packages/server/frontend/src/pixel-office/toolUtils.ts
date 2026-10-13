/** Map status prefixes back to tool names for animation selection */
export const STATUS_TO_TOOL: Record<string, string> = {
  'Reading': 'Read',
  'Searching': 'Grep',
  'Globbing': 'Glob',
  'Fetching': 'WebFetch',
  'Searching web': 'WebSearch',
  'Writing': 'Write',
  'Editing': 'Edit',
  'Running': 'Bash',
  'Task': 'Task',
}

export function extractToolName(status: string): string | null {
  for (const [prefix, tool] of Object.entries(STATUS_TO_TOOL)) {
    if (status.startsWith(prefix)) return tool
  }
  const first = status.split(/[\s:]/)[0]
  return first || null
}

import { ZOOM_DEFAULT_DPR_FACTOR, ZOOM_MIN, ZOOM_MAX, TILE_SIZE } from '../pixel-constants.js'

/** Compute a default integer zoom level (device pixels per sprite pixel) */
export function defaultZoom(): number {
  const dpr = window.devicePixelRatio || 1
  return Math.max(ZOOM_MIN, Math.round(ZOOM_DEFAULT_DPR_FACTOR * dpr))
}

/**
 * 让整张地图正好装进画布的最大整数缩放（画布尺寸是设备像素）。
 *
 * 默认缩放 round(2×dpr) 是给上游那间 20×11 固定办公室定的；现在一台开发机一栋房子，
 * 地图动辄 45×31，按默认缩放进去只看得见中间一小块。缩放必须是整数：
 * 渲染是按 zoom 把精灵栅格化进缓存的，分数缩放既糊又会把缓存撑爆。
 */
export function fitZoom(cols: number, rows: number, canvasW: number, canvasH: number): number {
  if (!cols || !rows || canvasW <= 0 || canvasH <= 0) return defaultZoom()
  const byW = Math.floor(canvasW / (cols * TILE_SIZE))
  const byH = Math.floor(canvasH / (rows * TILE_SIZE))
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min(byW, byH)))
}
