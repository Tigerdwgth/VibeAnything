import { useEffect, useRef } from 'react'
import type { OfficeState } from '../pixel-office/engine/officeState.js'
import { TILE_SIZE } from '../pixel-office/types.js'
import { viewportOf, worldToCss, tileCssSize } from '../pixel-office/engine/viewport.js'

// 房间名牌：**这间屋是哪个工作目录**。
//
// 楼层是按真实结构生成的（一台机器一层楼、一个目录一间房），但画布上只有像素墙，
// 不写名字就还是「不知道谁在哪」—— 这个组件就是把那层结构标出来。
// 机器名不在这里：一台机器一个标签页，名字写在标签上（以前挂在屋顶上方的那块名牌，
// 在「整层楼铺满画布」之后会飘到画布外面去）。
// 位置算法与 AgentLabels 同源（都走 engine/viewport.ts），并且同样**只渲染一次 DOM、
// 每帧只写 transform**：这些名牌数量不多，但相机一动就得跟着动，不能靠 React 重渲染。

interface PlaceLabelsProps {
  officeState: OfficeState
  containerRef: React.RefObject<HTMLDivElement | null>
  zoom: number
  panRef: React.RefObject<{ x: number; y: number }>
  /** 布局版本号。地图按新的目录结构重建后，靠它触发重渲染拿到新的 places。 */
  version: number
  /** 编辑模式下压暗：那时在摆家具，名牌只是参考 */
  dimmed?: boolean
}

const chipBase: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  borderRadius: 3,
  willChange: 'transform',
  cursor: 'help',
}

export function PlaceLabels({ officeState, containerRef, zoom, panRef, version, dimmed }: PlaceLabelsProps) {
  const nodesRef = useRef(new Map<string, HTMLDivElement>())
  const sizeRef = useRef({ width: 0, height: 0 })

  // places 随地图重建而变；version 变了这个组件就重渲染，这里读到的就是新的
  void version
  const places = officeState.places

  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined
    const measure = () => {
      const r = el.getBoundingClientRect()
      sizeRef.current = { width: r.width, height: r.height }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [containerRef])

  useEffect(() => {
    const byKey = new Map(places.map((p) => [`${p.kind}:${p.key}`, p]))
    let rafId = 0
    const follow = () => {
      const { width, height } = sizeRef.current
      if (width && height) {
        const v = viewportOf(officeState.getLayout(), zoom, panRef.current, { width, height })
        for (const [key, node] of nodesRef.current) {
          const place = byKey.get(key)
          if (!place) { node.style.display = 'none'; continue }
          const worldX = (place.col + place.cols / 2) * TILE_SIZE
          // 房间名贴在房间内部第一行 —— 那一行是生成器特意留空的（工位从第二行起排），
          // 否则小人的名牌会顶在同一个位置上
          const worldY = (place.row + 0.5) * TILE_SIZE
          const { x, y } = worldToCss(v, worldX, worldY)
          node.style.display = ''
          node.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -50%)`
        }
      }
      rafId = requestAnimationFrame(follow)
    }
    rafId = requestAnimationFrame(follow)
    return () => cancelAnimationFrame(rafId)
  }, [officeState, zoom, panRef, places])

  // 名牌不能比它标的东西还宽，否则会糊到隔壁房间上
  const tilePx = tileCssSize({ dpr: window.devicePixelRatio || 1, zoom, offsetX: 0, offsetY: 0 })

  return (
    <>
      {places.map((place) => (
        <div
          key={`${place.kind}:${place.key}`}
          ref={(node) => {
            const key = `${place.kind}:${place.key}`
            if (node) nodesRef.current.set(key, node)
            else nodesRef.current.delete(key)
          }}
          title={place.title || place.label}
          style={{
            ...chipBase,
            zIndex: 42,   // 在暗角(40)之上、小人名牌(44)之下
            opacity: dimmed ? 0.35 : 1,
            maxWidth: Math.max(48, place.cols * tilePx - 4),
            fontSize: '12px',
            fontWeight: 600,
            color: 'var(--vscode-foreground, #e6edf3)',
            background: 'rgba(12,12,20,0.72)',
            border: '1px solid transparent',
            padding: '1px 6px',
          }}
        >{place.label}</div>
      ))}
    </>
  )
}
