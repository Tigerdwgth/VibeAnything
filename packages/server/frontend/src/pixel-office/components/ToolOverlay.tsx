import { useState, useEffect, useRef } from 'react'
import type { ToolActivity } from '../types.js'
import type { OfficeState } from '../engine/officeState.js'
import type { SubagentCharacter } from '../../pixel-hooks/useExtensionMessages.js'
import { TILE_SIZE, CharacterState } from '../types.js'
import { CHARACTER_SITTING_OFFSET_PX } from '../../pixel-constants.js'

/** 卡片上沿离脚底多远（世界像素） */
const TOOL_OVERLAY_FOOT_GAP_PX = 2

interface ToolOverlayProps {
  officeState: OfficeState
  agents: number[]
  agentTools: Record<number, ToolActivity[]>
  subagentCharacters: SubagentCharacter[]
  containerRef: React.RefObject<HTMLDivElement | null>
  zoom: number
  panRef: React.RefObject<{ x: number; y: number }>
  onCloseAgent: (id: number) => void
}

/** Derive a short human-readable activity string from tools/status */
function getActivityText(
  agentId: number,
  agentTools: Record<number, ToolActivity[]>,
  isActive: boolean,
): string {
  const tools = agentTools[agentId]
  if (tools && tools.length > 0) {
    // Find the latest non-done tool
    const activeTool = [...tools].reverse().find((t) => !t.done)
    if (activeTool) {
      if (activeTool.permissionWait) return '等你确认'
      return activeTool.status
    }
    // All tools done but agent still active (mid-turn) — keep showing last tool status
    if (isActive) {
      const lastTool = tools[tools.length - 1]
      if (lastTool) return lastTool.status
    }
  }

  return '空闲'
}

export function ToolOverlay({
  officeState,
  agents,
  agentTools,
  subagentCharacters,
  containerRef,
  zoom,
  panRef,
  onCloseAgent,
}: ToolOverlayProps) {
  // 这个覆盖层绝大多数时候什么都不画（见下面 `if (!isSelected && !isHovered) return null`），
  // 但原来它**每帧**都 setTick 触发一次完整的 React 渲染，组件体里还同步调一次
  // getBoundingClientRect（每帧一次强制同步布局）。在 120Hz 的 ProMotion 上就是
  // 120 次/秒的无用渲染 + 布局，整个 Dashboard（包括终端）跟着掉帧、风扇起转。
  //
  // 改成：只有真的有选中/悬停的小人时才跑 rAF；容器尺寸由 ResizeObserver 缓存，
  // 不在渲染里量。
  //
  // 选中/悬停是画布直接写在 officeState 上的（不经过 React），所以「有没有人被悬停」
  // 不能在渲染时读一次就完事 —— 原来就是这么读的，结果鼠标移到小人身上什么都不出，
  // 要等别的什么东西碰巧触发一次重渲染（最长 2.5 秒一轮的会话列表）才弹出来。
  // 这里每帧看一眼这两个 id：变了，或者有人被选中/悬停（卡片要跟着人走），才重渲染。
  const [, setTick] = useState(0)
  useEffect(() => {
    let rafId = 0
    let seen = { sel: officeState.selectedAgentId, hov: officeState.hoveredAgentId }
    const tick = () => {
      const sel = officeState.selectedAgentId
      const hov = officeState.hoveredAgentId
      if (sel !== seen.sel || hov !== seen.hov || sel !== null || hov !== null) {
        seen = { sel, hov }
        setTick((n) => n + 1)
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [officeState])

  const sizeRef = useRef({ width: 0, height: 0 })
  useEffect(() => {
    const el2 = containerRef.current
    if (!el2) return undefined
    const measure = () => {
      const r = el2.getBoundingClientRect()
      sizeRef.current = { width: r.width, height: r.height }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el2)
    return () => ro.disconnect()
  }, [containerRef])

  const el = containerRef.current
  if (!el) return null
  const rect = sizeRef.current.width ? sizeRef.current : el.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const canvasW = Math.round(rect.width * dpr)
  const canvasH = Math.round(rect.height * dpr)
  const layout = officeState.getLayout()
  const mapW = layout.cols * TILE_SIZE * zoom
  const mapH = layout.rows * TILE_SIZE * zoom
  const deviceOffsetX = Math.floor((canvasW - mapW) / 2) + Math.round(panRef.current.x)
  const deviceOffsetY = Math.floor((canvasH - mapH) / 2) + Math.round(panRef.current.y)

  const selectedId = officeState.selectedAgentId
  const hoveredId = officeState.hoveredAgentId

  // All character IDs
  const allIds = [...agents, ...subagentCharacters.map((s) => s.id)]

  return (
    <>
      {allIds.map((id) => {
        const ch = officeState.characters.get(id)
        if (!ch) return null

        const isSelected = selectedId === id
        const isHovered = hoveredId === id
        const isSub = ch.isSubagent

        // Only show for hovered or selected agents
        if (!isSelected && !isHovered) return null

        // 挂在脚下：头顶已经有名牌（和气泡）了，原来这张卡片也挂在头顶，三样东西叠成一坨
        const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0
        const screenX = (deviceOffsetX + ch.x * zoom) / dpr
        const screenY = (deviceOffsetY + (ch.y + sittingOffset + TOOL_OVERLAY_FOOT_GAP_PX) * zoom) / dpr

        // Get activity text
        const subHasPermission = isSub && ch.bubbleType === 'permission'
        let activityText: string
        if (isSub) {
          if (subHasPermission) {
            activityText = '等你确认'
          } else {
            const sub = subagentCharacters.find((s) => s.id === id)
            activityText = sub ? sub.label : 'Subtask'
          }
        } else {
          activityText = getActivityText(id, agentTools, ch.isActive)
        }

        // Determine dot color
        const tools = agentTools[id]
        const hasPermission = subHasPermission || tools?.some((t) => t.permissionWait && !t.done)
        const hasActiveTools = tools?.some((t) => !t.done)
        const isActive = ch.isActive

        let dotColor: string | null = null
        if (hasPermission) {
          dotColor = 'var(--pixel-status-permission)'
        } else if (isActive && hasActiveTools) {
          dotColor = 'var(--pixel-status-active)'
        }

        return (
          <div
            key={id}
            style={{
              position: 'absolute',
              left: screenX,
              top: screenY,
              transform: 'translateX(-50%)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              pointerEvents: isSelected ? 'auto' : 'none',
              zIndex: isSelected ? 'var(--pixel-overlay-selected-z)' : 'var(--pixel-overlay-z)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                background: 'var(--pixel-bg)',
                border: isSelected
                  ? '2px solid var(--pixel-border-light)'
                  : '2px solid var(--pixel-border)',
                borderRadius: 4,
                padding: isSelected ? '2px 4px 2px 7px' : '2px 7px',
                boxShadow: 'var(--pixel-shadow)',
                whiteSpace: 'nowrap',
                maxWidth: 220,
              }}
            >
              {dotColor && (
                <span
                  className={isActive && !hasPermission ? 'pixel-agents-pulse' : undefined}
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: dotColor,
                    flexShrink: 0,
                  }}
                />
              )}
              <span
                style={{
                  fontSize: isSub ? '11px' : '11.5px',
                  fontStyle: isSub ? 'italic' : undefined,
                  color: 'var(--vscode-foreground)',
                  fontFamily: 'var(--pixel-font, system-ui)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {activityText}
              </span>
              {isSelected && !isSub && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onCloseAgent(id)
                  }}
                  title="Close agent"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--pixel-close-text)',
                    cursor: 'pointer',
                    padding: '0 2px',
                    fontSize: '14px',
                    lineHeight: 1,
                    marginLeft: 2,
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.color = 'var(--pixel-close-hover)'
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.color = 'var(--pixel-close-text)'
                  }}
                >
                  ×
                </button>
              )}
            </div>
          </div>
        )
      })}
    </>
  )
}
