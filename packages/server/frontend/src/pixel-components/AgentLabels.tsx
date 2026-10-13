import { useEffect, useLayoutEffect, useRef } from 'react'
import type { OfficeState } from '../pixel-office/engine/officeState.js'
import type { SubagentCharacter, AgentInfo } from '../pixel-hooks/useExtensionMessages.js'
import { CharacterState } from '../pixel-office/types.js'
import { viewportOf, worldToCss } from '../pixel-office/engine/viewport.js'

// 小人头顶的名牌：**谁**（会话名）、**在哪台机器**、**在干嘛**（运行中/空闲/等待确认）。
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

interface AgentLabelsProps {
  officeState: OfficeState
  agents: number[]
  agentStatuses: Record<number, string>
  agentInfos: Record<number, AgentInfo>
  containerRef: React.RefObject<HTMLDivElement | null>
  zoom: number
  panRef: React.RefObject<{ x: number; y: number }>
  subagentCharacters: SubagentCharacter[]
}

/** 名牌相对小人脚底的抬升（世界像素） */
const LABEL_LIFT_PX = 26

/** 叠上去时两块名牌之间留的缝（CSS 像素） */
const LABEL_STACK_GAP_PX = 2

/** 一块名牌最多往上让几次 —— 让不开就只能叠着，总比无限往上飘强 */
const MAX_LABEL_STACK = 6

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
  agentStatuses,
  agentInfos,
  containerRef,
  zoom,
  panRef,
  subagentCharacters,
}: AgentLabelsProps) {
  // id → 名牌的 DOM 节点。rAF 里直接写它们的 transform，不走 React。
  const nodesRef = useRef(new Map<number, HTMLDivElement>())
  const sizeRef = useRef({ width: 0, height: 0 })
  // id → 名牌自身的宽高。只在 React 渲染之后量（文字变了宽度才会变），
  // 每帧去读 offsetWidth 等于每帧强制同步布局，小人一走动就卡。
  const boxRef = useRef(new Map<number, { w: number; h: number }>())

  useLayoutEffect(() => {
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
          // 声明」，连 React 写的 display:flex 一起抹掉 —— 名牌于是退化成 display:block，
          // 三个 span 排成一行（名字和状态并排、6px 的状态灯因为是 inline 而宽度为 0，
          // 整整一版都没人见过那盏灯），还白白宽了一倍，这才是「挤成一坨」的真正放大器。
          if (!ch) { node.style.visibility = 'hidden'; continue }
          const sitting = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET : 0
          const { x, y } = worldToCss(v, ch.x, ch.y + sitting - LABEL_LIFT_PX)
          const box = boxRef.current.get(id)
          anchors.push({ id, x, y, w: box?.w || 0, h: box?.h || 0 })
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

  const subLabelMap = new Map<number, string>()
  for (const sub of subagentCharacters) subLabelMap.set(sub.id, sub.label)

  const allIds = [...agents, ...subagentCharacters.map((s) => s.id)]

  return (
    <>
      {allIds.map((id) => {
        const info = agentInfos[id]
        const status = agentStatuses[id]
        const isSub = subLabelMap.has(id)
        const isWaiting = status === 'waiting'
        // 「在跑」以集成层下发的 running 为准（与侧栏红绿灯同源）
        const isRunning = info ? info.running : false

        // 颜色语义与侧栏红绿灯**完全一致**：红=正在跑、绿=空闲、黄=等你确认。
        // 原来是 done→红 / waiting→黄 / active→蓝：于是「跑完了」在小镇上是红的、
        // 在侧栏里是绿的，两边互相矛盾。
        const isOffline = !!info?.offline
        let dotColor = 'transparent'
        if (isOffline) dotColor = 'rgba(148,163,184,0.7)'      // 灰：机器上已经没有这个会话了
        else if (isWaiting) dotColor = 'var(--vscode-charts-yellow, #f59e0b)'
        else if (isRunning) dotColor = 'var(--vscode-charts-red, #ef4444)'
        else if (!isSub) dotColor = 'var(--vscode-charts-green, #10b981)'

        const labelText = subLabelMap.get(id) || info?.label || `Agent #${id}`
        const state = isOffline ? '离线' : isWaiting ? '等待确认' : isRunning ? `${info?.tool} 运行中` : '空闲'
        // 副行只在它比状态灯多说了点什么时才出现：
        //  · 机器名由房子的屋顶名牌负责，不必每个人再背一遍（这一行原本是
        //    十个人挤一间房时糊成一团的主因）；
        //  · 「空闲」= 绿灯，重复一遍只是占地方；在跑的那几个才需要写清在跑什么工具。
        const subLine = !isSub && info && (isRunning || isWaiting || isOffline) ? state : ''
        const hoverTitle = info ? `${info.label}\n${info.machine}${info.cwd ? `\n${info.cwd}` : ''}` : undefined

        return (
          <div
            key={id}
            ref={(node) => {
              if (node) nodesRef.current.set(id, node)
              else nodesRef.current.delete(id)
            }}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              pointerEvents: 'none',   // 名牌不能挡住点小人
              zIndex: 44,              // 在暗角(40)之上、控件(50)之下
              willChange: 'transform',
            }}
          >
            {isWaiting && !isOffline ? (
              /* 等你确认是唯一需要人动手的状态 —— 用感叹号，比一个小圆点显眼 */
              <span style={{
                fontSize: '14px', fontWeight: 'bold', color: dotColor, lineHeight: 1, marginBottom: 2,
                textShadow: '0 0 6px rgba(245,158,11,0.7)',
              }}>!</span>
            ) : dotColor !== 'transparent' && (
              <span
                className={isRunning && !isOffline ? 'pixel-agents-pulse' : undefined}
                style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor, marginBottom: 2 }}
              />
            )}
            <span
              title={hoverTitle}
              style={{
                fontSize: isSub ? '11px' : '12px',
                fontStyle: isSub ? 'italic' : undefined,
                fontWeight: isSub ? 400 : 600,
                color: 'var(--vscode-foreground, #e6edf3)',
                opacity: isOffline ? 0.55 : 1,
                background: 'rgba(22,22,31,0.86)',
                border: '1px solid var(--pixel-border, rgba(255,255,255,0.12))',
                padding: '1px 5px',
                borderRadius: 3,
                whiteSpace: 'nowrap',
                maxWidth: 170,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >{labelText}</span>
            {subLine && (
              <span style={{
                fontSize: '10px',
                color: 'var(--vscode-foreground, #e6edf3)',
                opacity: 0.72,
                background: 'rgba(22,22,31,0.72)',
                padding: '0 4px',
                borderRadius: 3,
                whiteSpace: 'nowrap',
                maxWidth: 170,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                marginTop: 1,
              }}>{subLine}</span>
            )}
          </div>
        )
      })}
    </>
  )
}

// 坐下时精灵会下沉几像素，名牌要跟着沉，否则坐着的人名牌会飘在头顶上方
const CHARACTER_SITTING_OFFSET = 6
