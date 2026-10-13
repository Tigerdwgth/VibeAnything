import { TILE_SIZE } from '../types.js'
import type { OfficeLayout } from '../types.js'

/**
 * 画布的「居中 + 平移」数学，抽出来给 DOM 名牌层用。
 *
 * 名牌（小人头顶的、房间/房子的）都是 DOM 元素，必须和 canvas 里的像素严格对齐 ——
 * 差一个 dpr 或者少一次 Math.floor，缩放之后名牌就会从它该贴的东西上飘走。
 * 所以这里和 renderer.renderFrame 用的是同一套算式，改一边必须改另一边。
 */
export interface Viewport {
  dpr: number
  zoom: number
  offsetX: number
  offsetY: number
}

export function viewportOf(
  layout: Pick<OfficeLayout, 'cols' | 'rows'>,
  zoom: number,
  pan: { x: number; y: number },
  sizeCss: { width: number; height: number },
): Viewport {
  const dpr = window.devicePixelRatio || 1
  const canvasW = Math.round(sizeCss.width * dpr)
  const canvasH = Math.round(sizeCss.height * dpr)
  const mapW = layout.cols * TILE_SIZE * zoom
  const mapH = layout.rows * TILE_SIZE * zoom
  return {
    dpr,
    zoom,
    offsetX: Math.floor((canvasW - mapW) / 2) + Math.round(pan.x),
    offsetY: Math.floor((canvasH - mapH) / 2) + Math.round(pan.y),
  }
}

/** 世界坐标（精灵像素）→ 容器内的 CSS 坐标 */
export function worldToCss(v: Viewport, worldX: number, worldY: number): { x: number; y: number } {
  return {
    x: (v.offsetX + worldX * v.zoom) / v.dpr,
    y: (v.offsetY + worldY * v.zoom) / v.dpr,
  }
}

/** 一格在屏幕上占多少 CSS 像素（名牌宽度要按房间宽度收，否则会糊到隔壁房间） */
export function tileCssSize(v: Viewport): number {
  return (TILE_SIZE * v.zoom) / v.dpr
}
