import { useEffect, useLayoutEffect, useRef } from 'react'
import type { OfficeState } from '../pixel-office/engine/officeState.js'
import type { SubagentCharacter, AgentInfo } from '../pixel-hooks/useExtensionMessages.js'
import { CharacterState } from '../pixel-office/types.js'
import type { AgentPhase } from '../pixel-office/types.js'
import { viewportOf, worldToCss } from '../pixel-office/engine/viewport.js'
import {
  CHARACTER_SITTING_OFFSET_PX, BUBBLE_SITTING_OFFSET_PX, BUBBLE_VERTICAL_OFFSET_PX,
} from '../pixel-constants.js'
import { SESSION_WORKING_LABEL } from '../session-light.js'

// 小人头顶的名牌：**谁**（会话名）、**在干嘛**（工作中 / 干完了等你 / 等你确认 / 空闲）。
// 点名牌 = 点小人：打开那个会话的终端。
//
// 这个组件以前存在但**从未被渲染**（没有任何地方 import 它），所以画布上的小人一直是
// 一群没有名字的像素人 —— 「不知道哪个人在干嘛」就是这么来的。原来的实现还有两个坑，
// 这次一起解决：
//
//  1. 它每帧 `setTick` 触发一次完整 React 渲染，组件体里又同步 getBoundingClientRect
//     （每帧一次强制同步布局）。小人是会走动的，名牌必须跟着动，所以不能靠「变了才渲染」
//     —— 这里改成**只渲染一次 DOM，位置用 rAF 直接写 style.transform**，
//     React 完全不参与每帧更新。
//  2. 文字颜色写的是 `var(--vscode-foreground)` 且无兜底，而这个应用里从来没有定义过
//     那个变量（它来自 VS Code 宿主），整条 color 声明作废。现在统一用 pixel-theme.js
//     里补齐的令牌，并带兜底色。
//
// 颜色与侧栏红绿灯同源（session-light.js）：黄 = 工作中、绿 = 空闲；干完了等你是绿色实心
// 标记，卡在权限确认上是红色实心标记 —— 这两种是一屏里唯一要人动手的，必须最先跳出来。

interface AgentLabelsProps {
  officeState: OfficeState
  agents: number[]
  agentStatuses?: Record<number, string>
  agentInfos: Record<number, AgentInfo>
  /** 会话的工作阶段（集成层推下来的），名牌颜色与标记都看它 */
  agentPhases?: Record<number, AgentPhase>
  containerRef: React.RefObject<HTMLDivElement | null>
  zoom: number
  panRef: React.RefObject<{ x: number; y: number }>
  subagentCharacters: SubagentCharacter[]
  /** 点名牌 = 点小人：打开那个会话的终端 */
  onSelect?: (id: number) => void
}

/** 精灵高度（世界像素）：名牌贴在头顶上方 */
const SPRITE_H_PX = 24

/** 头顶气泡本身的高度（世界像素，见 spriteData 的 BUBBLE_*_SPRITE）。气泡的位置与
 *  renderer.renderBubbles 同一套偏移：下沿 = 脚底 + 坐姿偏移 − BUBBLE_VERTICAL_OFFSET_PX − 1 */
const BUBBLE_H_PX = 13

/** 名牌与头顶（或气泡）之间留的缝（世界像素） */
const LABEL_GAP_PX = 1

/** 叠上去时两块名牌之间留的缝（CSS 像素） */
const LABEL_STACK_GAP_PX = 2

/** 一块名牌最多往上让几次 —— 让不开就只能叠着，总比无限往上飘强 */
const MAX_LABEL_STACK = 6

/** 每个阶段在名牌上的颜色与标记（色值来自 pixel-theme.js，与侧栏红绿灯同源） */
const PHASE_LOOK: Record<AgentPhase, { color: string; dim: string; tag: string; mark: string }> = {
  working: { color: 'var(--pixel-working, #facc15)', dim: 'var(--pixel-working-dim)', tag: SESSION_WORKING_LABEL, mark: '' },
  permission: { color: 'var(--pixel-permission, #ef4444)', dim: 'var(--pixel-permission-dim)', tag: '等你确认', mark: '!' },
  done: { color: 'var(--pixel-done, #10b981)', dim: 'var(--pixel-done-dim)', tag: '完成 · 等你', mark: '✓' },
  idle: { color: 'var(--pixel-idle, #10b981)', dim: '', tag: '', mark: '' },
}
const OFFLINE_LOOK = { color: 'var(--pixel-offline, rgba(148,163,184,0.7))', dim: '', tag: '离线', mark: '' }

export interface LabelPlacement {
  /** 小人头顶的锚点（CSS 像素，x 是名牌的水平中心） */
  id: number
  x: number
  y: number
  w: number
  h: number
}

/**
 * 名牌的防重叠排布：同一间房里坐十个人时，名牌会糊成一团，连房间名牌都盖住
 * （2026-10-10 线上实测）。这里按「靠下的先占位、被挡住的往上让」摆开。
 *
 * 为什么是靠下的先占位：画面是俯视 2.5D，靠下 = 视觉上的前排，前排的名牌留在自己
 * 头顶最不容易认错人；后排的往上让，正好让到空旷的地方去。
 *
 * 排序只用量化过的 y（和 id 兜底），不用原始 y —— 小人走动时两个人的 y 会反复
 * 互相穿过，拿原始 y 排序会让两块名牌每帧交换上下位，看起来就是在抖。
 *
 * @param items 每块名牌的锚点与尺寸
 * @returns id → 最终的 y（x 不变）
 */
export function stackLabels(items: LabelPlacement[]): Map<number, number> {
  const order = [...items].sort((a, b) => {
    const qa = Math.round(a.y / 8)
    const qb = Math.round(b.y / 8)
    return qb - qa || a.id - b.id
  })
  const placed: { l: number; r: number; t: number; b: number }[] = []
  const out = new Map<number, number>()
  for (const it of order) {
    const l = it.x - it.w / 2
    const r = it.x + it.w / 2
    let t = it.y
    for (let i = 0; i < MAX_LABEL_STACK; i++) {
      const b = t + it.h
      const hit = placed.some((p) => l < p.r && r > p.l && t < p.b && b > p.t)
      if (!hit) break
      t -= it.h + LABEL_STACK_GAP_PX
    }
    placed.push({ l, r, t, b: t + it.h })
    out.set(it.id, t)
  }
  return out
}


export function AgentLabels({
  officeState,
  agents,
  agentInfos,
  agentPhases,
  containerRef,
  zoom,
  panRef,
  subagentCharacters,
  onSelect,
}: AgentLabelsProps) {
  // id → 名牌的 DOM 节点。rAF 里直接写它们的 transform，不走 React。
  const nodesRef = useRef(new Map<number, HTMLDivElement>())
  const sizeRef = useRef({ width: 0, height: 0 })
  // id → 名牌自身的宽高。只在 React 渲染之后量（文字变了宽度才会变），
  // 每帧去读 offsetWidth 等于每帧强制同步布局，小人一走动就卡。
  const boxRef = useRef(new Map<number, { w: number; h: number }>())

  useLayoutEffect(() => {
    // 整表重量：关掉的会话不能在这里留一条（id 只增不减，留着就是只涨不落）
    boxRef.current.clear()
    for (const [id, node] of nodesRef.current) {
      boxRef.current.set(id, { w: node.offsetWidth, h: node.offsetHeight })
    }
  })

  // 容器尺寸只在真的变化时量一次（原来是每帧量）
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

  // 跟随：每帧只做「算坐标 + 写 transform」，没有 setState、没有 reconcile
  useEffect(() => {
    let rafId = 0
    const follow = () => {
      const { width, height } = sizeRef.current
      if (width && height) {
        // 居中 + pan 的数学与 renderer.renderFrame 同源（engine/viewport.ts），
        // 房间/房子的名牌也走同一份，三处不能各写一遍
        const v = viewportOf(officeState.getLayout(), zoom, panRef.current, { width, height })

        const anchors: LabelPlacement[] = []
        for (const [id, node] of nodesRef.current) {
          const ch = officeState.characters.get(id)
          // 显隐用 visibility，**不能用 display**：`style.display = ''` 是「删掉这条内联
          // 声明」，连 React 写的 display:flex 一起抹掉 —— 名牌于是退化成 display:block。
          if (!ch) { node.style.visibility = 'hidden'; continue }
          // 名牌的下沿贴在头顶上方；头顶挂着气泡（干完了 / 等权限）时贴在气泡上方 ——
          // 原来名牌的上沿对着头顶往下画，正好盖住脸，有气泡时也会把气泡整个盖掉
          const sitting = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0
          let bottomWorld = ch.y + sitting - SPRITE_H_PX
          if (ch.bubbleType) {
            const bubbleSit = ch.state === CharacterState.TYPE ? BUBBLE_SITTING_OFFSET_PX : 0
            bottomWorld = Math.min(bottomWorld, ch.y + bubbleSit - BUBBLE_VERTICAL_OFFSET_PX - 1 - BUBBLE_H_PX)
          }
          const { x, y } = worldToCss(v, ch.x, bottomWorld - LABEL_GAP_PX)
          const box = boxRef.current.get(id)
          const h = box?.h || 0
          anchors.push({ id, x, y: y - h, w: box?.w || 0, h })
        }
        // 人挤在一间房里时名牌会互相盖住，这里统一让开（见 stackLabels）
        const ys = stackLabels(anchors)
        for (const a of anchors) {
          const node = nodesRef.current.get(a.id)
          if (!node) continue
          node.style.visibility = ''
          node.style.transform = `translate(${Math.round(a.x)}px, ${Math.round(ys.get(a.id) ?? a.y)}px) translateX(-50%)`
        }
      }
      rafId = requestAnimationFrame(follow)
    }
    rafId = requestAnimationFrame(follow)
    return () => cancelAnimationFrame(rafId)
  }, [officeState, zoom, panRef])

  // 名牌是可以点的，它就会挡住底下画布的滚轮：触控板双指平移/捏合落在名牌上时
  // 整个 Dashboard 跟着滚、跟着缩。这里把落在名牌上的滚轮原样转给画布。
  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined
    const onWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement | null
      if (!target?.closest?.('.pixel-agent-chip')) return
      const canvas = el.querySelector('canvas')
      if (!canvas) return
      e.preventDefault()
      canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode,
        ctrlKey: e.ctrlKey, metaKey: e.metaKey, clientX: e.clientX, clientY: e.clientY, cancelable: true,
      }))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [containerRef])

  const subLabelMap = new Map<number, string>()
  for (const sub of subagentCharacters) subLabelMap.set(sub.id, sub.label)

  const allIds = [...agents, ...subagentCharacters.map((s) => s.id)]

  return (
    <>
      {allIds.map((id) => {
        const info = agentInfos[id]
        const isSub = subLabelMap.has(id)
        const isOffline = !!info?.offline
        // 阶段以集成层推下来的为准；还没推到（刚建出来那一帧）时按 running 先顶上
        const phase: AgentPhase = agentPhases?.[id] ?? (info?.running ? 'working' : 'idle')
        const look = isOffline ? OFFLINE_LOOK : PHASE_LOOK[phase]
        const strong = !isOffline && !isSub && (phase === 'done' || phase === 'permission')

        const labelText = subLabelMap.get(id) || info?.label || `Agent #${id}`
        // 副行只在它比状态灯多说了点什么时才出现：机器名由标签页负责（悬停还查得到），
        // 「空闲」= 绿灯，重复一遍只是占地方
        let tag = ''
        if (!isSub && info) {
          if (isOffline) tag = look.tag
          else if (phase === 'working') tag = `${info.tool} ${SESSION_WORKING_LABEL}`
          else tag = look.tag
        }
        const hoverTitle = info
          ? `${info.label}\n${info.machine}${info.cwd ? `\n${info.cwd}` : ''}\n点击打开终端`
          : undefined
        const chipBorder = phase === 'idle' || isOffline || isSub
          ? 'var(--pixel-label-border, rgba(255,255,255,0.14))'
          : look.color

        return (
          <div
            key={id}
            ref={(node) => {
              if (node) nodesRef.current.set(id, node)
              else nodesRef.current.delete(id)
            }}
            data-phase={isOffline ? 'offline' : phase}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              pointerEvents: 'none',   // 整块不挡画布，只有名字那颗胶囊可以点
              zIndex: 44,              // 在暗角(40)之上、控件(50)之下
              willChange: 'transform',
              fontFamily: 'var(--pixel-font, system-ui)',
            }}
          >
            {tag && (
              // 状态标记在名字上面：名字贴着头顶，人和名字不会因为副行被拉开
              <span style={{
                marginBottom: 1,
                fontSize: '10px',
                fontWeight: strong ? 700 : 600,
                lineHeight: 1.35,
                padding: '0 5px',
                borderRadius: 3,
                whiteSpace: 'nowrap',
                maxWidth: 170,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                // 要你动手的（干完了 / 等权限）用实心色块，一屏里最先跳出来；工作中只染字色
                color: strong ? 'var(--pixel-panel-bg, #0f0f17)' : isOffline ? 'var(--pixel-label-sub)' : look.color,
                background: strong ? look.color : 'var(--pixel-label-bg, rgba(22,22,31,0.86))',
                boxShadow: 'var(--pixel-label-shadow)',
              }}>{strong ? `${look.mark} ${tag}` : tag}</span>
            )}
            <button
              type="button"
              className="pixel-agent-chip"
              title={hoverTitle}
              onClick={() => onSelect?.(id)}
              style={{
                pointerEvents: 'auto',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                margin: 0,
                fontFamily: 'inherit',
                fontSize: isSub ? '11px' : '12px',
                fontStyle: isSub ? 'italic' : undefined,
                fontWeight: isSub ? 400 : strong ? 700 : 600,
                lineHeight: 1.3,
                color: 'var(--pixel-label-text, #e6edf3)',
                opacity: isOffline ? 0.55 : 1,
                background: look.dim
                  ? `linear-gradient(${look.dim}, ${look.dim}), var(--pixel-label-bg, rgba(22,22,31,0.9))`
                  : 'var(--pixel-label-bg, rgba(22,22,31,0.9))',
                border: `1px solid ${chipBorder}`,
                boxShadow: 'var(--pixel-label-shadow)',
                padding: '1px 6px 1px 5px',
                borderRadius: 4,
                whiteSpace: 'nowrap',
                maxWidth: 170,
              }}
            >
              <span
                className={phase === 'working' && !isOffline ? 'pixel-phase-pulse' : undefined}
                style={{
                  width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                  background: isSub ? 'var(--pixel-label-sub, #94a3b8)' : look.color,
                  boxShadow: phase === 'working' && !isOffline ? `0 0 5px ${look.color}` : undefined,
                }}
              />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{labelText}</span>
            </button>
          </div>
        )
      })}
    </>
  )
}
