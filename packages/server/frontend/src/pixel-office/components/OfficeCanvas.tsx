import { useRef, useEffect, useCallback } from 'react'
import type { OfficeState } from '../engine/officeState.js'
import type { EditorState } from '../editor/editorState.js'
import type { EditorRenderState, SelectionRenderState, DeleteButtonBounds, RotateButtonBounds } from '../engine/renderer.js'
import { startGameLoop } from '../engine/gameLoop.js'
import { renderFrame } from '../engine/renderer.js'
import { TILE_SIZE, EditTool } from '../types.js'
import { CAMERA_FOLLOW_LERP, CAMERA_FOLLOW_SNAP_THRESHOLD, ZOOM_MIN, ZOOM_MAX, ZOOM_SCROLL_THRESHOLD, PAN_MARGIN_FRACTION } from '../../pixel-constants.js'
import { getCatalogEntry, isRotatable } from '../layout/furnitureCatalog.js'
import { fitZoom } from '../toolUtils.js'
import { canPlaceFurniture, getWallPlacementRow } from '../editor/editorActions.js'
import { vscode } from '../../pixel-vscodeApi.js'
import { unlockAudio } from '../../pixel-notificationSound.js'

interface OfficeCanvasProps {
  officeState: OfficeState
  onClick: (agentId: number) => void
  isEditMode: boolean
  editorState: EditorState
  onEditorTileAction: (col: number, row: number) => void
  onEditorEraseAction: (col: number, row: number) => void
  onEditorSelectionChange: () => void
  onDeleteSelected: () => void
  onRotateSelected: () => void
  onDragMove: (uid: string, newCol: number, newRow: number) => void
  editorTick: number
  zoom: number
  onZoomChange: (zoom: number) => void
  /** 地图尺寸变了时请求「自动贴合」缩放（用户自己缩放过之后会被忽略） */
  onAutoZoom: (zoom: number) => void
  panRef: React.MutableRefObject<{ x: number; y: number }>
}

export function OfficeCanvas({ officeState, onClick, isEditMode, editorState, onEditorTileAction, onEditorEraseAction, onEditorSelectionChange, onDeleteSelected, onRotateSelected, onDragMove, editorTick: _editorTick, zoom, onZoomChange, onAutoZoom, panRef }: OfficeCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const offsetRef = useRef({ x: 0, y: 0 })
  // 渲染时用的 devicePixelRatio（命中测试必须同源，见 resizeCanvas）
  const dprRef = useRef(window.devicePixelRatio || 1)
  // 上一帧的 dt（秒）。render 回调拿不到 dt，相机跟随要靠它做帧率无关插值
  const dtRef = useRef(1 / 60)
  // 游戏循环要读的可变值走 ref，不进 effect 依赖 —— 见下面那个 effect 的说明
  const zoomRef = useRef(zoom)
  const isEditModeRef = useRef(isEditMode)
  const editorStateRef = useRef(editorState)
  const onAutoZoomRef = useRef(onAutoZoom)
  // 上一次做过「自动贴合」的地图尺寸（`cols×rows`）
  const fittedSizeRef = useRef('')
  zoomRef.current = zoom
  isEditModeRef.current = isEditMode
  editorStateRef.current = editorState
  onAutoZoomRef.current = onAutoZoom
  // Middle-mouse pan state (imperative, no re-renders)
  const isPanningRef = useRef(false)
  const panStartRef = useRef({ mouseX: 0, mouseY: 0, panX: 0, panY: 0 })
  // Delete/rotate button bounds (updated each frame by renderer)
  const deleteButtonBoundsRef = useRef<DeleteButtonBounds | null>(null)
  const rotateButtonBoundsRef = useRef<RotateButtonBounds | null>(null)
  // Right-click erase dragging
  const isEraseDraggingRef = useRef(false)
  // Zoom scroll accumulator for trackpad pinch sensitivity
  const zoomAccumulatorRef = useRef(0)

  // Clamp pan so the map edge can't go past a margin inside the viewport
  const clampPan = useCallback((px: number, py: number): { x: number; y: number } => {
    const canvas = canvasRef.current
    if (!canvas) return { x: px, y: py }
    const layout = officeState.getLayout()
    const mapW = layout.cols * TILE_SIZE * zoom
    const mapH = layout.rows * TILE_SIZE * zoom
    const marginX = canvas.width * PAN_MARGIN_FRACTION
    const marginY = canvas.height * PAN_MARGIN_FRACTION
    const maxPanX = (mapW / 2) + canvas.width / 2 - marginX
    const maxPanY = (mapH / 2) + canvas.height / 2 - marginY
    return {
      x: Math.max(-maxPanX, Math.min(maxPanX, px)),
      y: Math.max(-maxPanY, Math.min(maxPanY, py)),
    }
  }, [officeState, zoom])

  // Resize canvas backing store to device pixels (no DPR transform on ctx)
  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const rect = container.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    // 记下这次用的 dpr：命中测试（screenToWorld）必须和渲染同源。
    // 以前它每次实时读 window.devicePixelRatio，而 canvas 里的 backing store 可能还是
    // 旧 dpr 画的 —— 把窗口从 Retina 拖到外接 1× 屏之后，两套单位混用，点小人整体偏一倍。
    dprRef.current = dpr
    canvas.width = Math.round(rect.width * dpr)
    canvas.height = Math.round(rect.height * dpr)
    canvas.style.width = `${rect.width}px`
    canvas.style.height = `${rect.height}px`
    // No ctx.scale(dpr) — we render directly in device pixels
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    resizeCanvas()

    const observer = new ResizeObserver(() => resizeCanvas())
    if (containerRef.current) {
      observer.observe(containerRef.current)
    }

    // 纯 DPR 变化（把窗口从 Retina 拖到外接 1× 屏）不改容器的 CSS 尺寸，
    // ResizeObserver 不会触发 —— backing store 还是旧 dpr 画的，画面变糊且点不中。
    // 这里盯住当前分辨率：一旦不再匹配就重新 resize。
    const dprQuery = window.matchMedia(`(resolution: ${dprRef.current}dppx)`)
    const onDprChange = () => resizeCanvas()
    dprQuery.addEventListener('change', onDprChange)

    const stop = startGameLoop(canvas, {
      update: (dt) => {
        dtRef.current = dt            // render 回调拿不到 dt，相机跟随要用
        officeState.update(dt)
      },
      render: (ctx) => {
        // Canvas dimensions are in device pixels
        const w = canvas.width
        const h = canvas.height

        // 地图尺寸变了（小镇按新的机器/目录结构重建、或第一次拿到画布尺寸）就贴合一次：
        // 缩放归到「整张地图看得见」，平移归零（renderFrame 里 pan=0 就是居中）。
        const sizeKey = `${officeState.getLayout().cols}x${officeState.getLayout().rows}`
        if (sizeKey !== fittedSizeRef.current && w > 0 && h > 0) {
          fittedSizeRef.current = sizeKey
          panRef.current = { x: 0, y: 0 }
          onAutoZoomRef.current(fitZoom(officeState.getLayout().cols, officeState.getLayout().rows, w, h))
        }

        // Build editor render state
        let editorRender: EditorRenderState | undefined
        if (isEditModeRef.current) {
          const showGhostBorder = editorStateRef.current.activeTool === EditTool.TILE_PAINT || editorStateRef.current.activeTool === EditTool.WALL_PAINT || editorStateRef.current.activeTool === EditTool.ERASE
          editorRender = {
            showGrid: true,
            ghostSprite: null,
            ghostCol: editorStateRef.current.ghostCol,
            ghostRow: editorStateRef.current.ghostRow,
            ghostValid: editorStateRef.current.ghostValid,
            selectedCol: 0,
            selectedRow: 0,
            selectedW: 0,
            selectedH: 0,
            hasSelection: false,
            isRotatable: false,
            deleteButtonBounds: null,
            rotateButtonBounds: null,
            showGhostBorder,
            ghostBorderHoverCol: showGhostBorder ? editorStateRef.current.ghostCol : -999,
            ghostBorderHoverRow: showGhostBorder ? editorStateRef.current.ghostRow : -999,
          }

          // Ghost preview for furniture placement
          if (editorStateRef.current.activeTool === EditTool.FURNITURE_PLACE && editorStateRef.current.ghostCol >= 0) {
            const entry = getCatalogEntry(editorStateRef.current.selectedFurnitureType)
            if (entry) {
              const placementRow = getWallPlacementRow(editorStateRef.current.selectedFurnitureType, editorStateRef.current.ghostRow)
              editorRender.ghostSprite = entry.sprite
              editorRender.ghostRow = placementRow
              editorRender.ghostValid = canPlaceFurniture(
                officeState.getLayout(),
                editorStateRef.current.selectedFurnitureType,
                editorStateRef.current.ghostCol,
                placementRow,
              )
            }
          }

          // Ghost preview for drag-to-move
          if (editorStateRef.current.isDragMoving && editorStateRef.current.dragUid && editorStateRef.current.ghostCol >= 0) {
            const draggedItem = officeState.getLayout().furniture.find((f) => f.uid === editorStateRef.current.dragUid)
            if (draggedItem) {
              const entry = getCatalogEntry(draggedItem.type)
              if (entry) {
                const ghostCol = editorStateRef.current.ghostCol - editorStateRef.current.dragOffsetCol
                const ghostRow = editorStateRef.current.ghostRow - editorStateRef.current.dragOffsetRow
                editorRender.ghostSprite = entry.sprite
                editorRender.ghostCol = ghostCol
                editorRender.ghostRow = ghostRow
                editorRender.ghostValid = canPlaceFurniture(
                  officeState.getLayout(),
                  draggedItem.type,
                  ghostCol,
                  ghostRow,
                  editorStateRef.current.dragUid,
                )
              }
            }
          }

          // Selection highlight
          if (editorStateRef.current.selectedFurnitureUid && !editorStateRef.current.isDragMoving) {
            const item = officeState.getLayout().furniture.find((f) => f.uid === editorStateRef.current.selectedFurnitureUid)
            if (item) {
              const entry = getCatalogEntry(item.type)
              if (entry) {
                editorRender.hasSelection = true
                editorRender.selectedCol = item.col
                editorRender.selectedRow = item.row
                editorRender.selectedW = entry.footprintW
                editorRender.selectedH = entry.footprintH
                editorRender.isRotatable = isRotatable(item.type)
              }
            }
          }
        }

        // Camera follow: smoothly center on followed agent
        if (officeState.cameraFollowId !== null) {
          const followCh = officeState.characters.get(officeState.cameraFollowId)
          if (followCh) {
            const layout = officeState.getLayout()
            const mapW = layout.cols * TILE_SIZE * zoomRef.current
            const mapH = layout.rows * TILE_SIZE * zoomRef.current
            const targetX = mapW / 2 - followCh.x * zoomRef.current
            const targetY = mapH / 2 - followCh.y * zoomRef.current
            const dx = targetX - panRef.current.x
            const dy = targetY - panRef.current.y
            if (Math.abs(dx) < CAMERA_FOLLOW_SNAP_THRESHOLD && Math.abs(dy) < CAMERA_FOLLOW_SNAP_THRESHOLD) {
              panRef.current = { x: targetX, y: targetY }
            } else {
              // 帧率无关的收敛：原来是每帧固定吸 10%，于是 120Hz 的 ProMotion 屏上
              // 跟随速度正好是 60Hz 的两倍（同一台 Mac 内屏/外接屏手感都不一样）。
              // 这里按「每 1/60 秒吸 10%」折算到本帧的 dt。
              const k = 1 - Math.pow(1 - CAMERA_FOLLOW_LERP, Math.max(dtRef.current, 0) * 60)
              panRef.current = {
                x: panRef.current.x + dx * k,
                y: panRef.current.y + dy * k,
              }
            }
          }
        }

        // Build selection render state
        const selectionRender: SelectionRenderState = {
          selectedAgentId: officeState.selectedAgentId,
          hoveredAgentId: officeState.hoveredAgentId,
          hoveredTile: officeState.hoveredTile,
          seats: officeState.seats,
          characters: officeState.characters,
        }

        const { offsetX, offsetY } = renderFrame(
          ctx,
          w,
          h,
          officeState.tileMap,
          officeState.furniture,
          officeState.getCharacters(),
          zoomRef.current,
          panRef.current.x,
          panRef.current.y,
          selectionRender,
          editorRender,
          officeState.getLayout().tileColors,
          officeState.getLayout().cols,
          officeState.getLayout().rows,
        )
        offsetRef.current = { x: offsetX, y: offsetY }

        // Store delete/rotate button bounds for hit-testing
        deleteButtonBoundsRef.current = editorRender?.deleteButtonBounds ?? null
        rotateButtonBoundsRef.current = editorRender?.rotateButtonBounds ?? null
      },
    })

    return () => {
      stop()
      observer.disconnect()
      dprQuery.removeEventListener('change', onDprChange)
    }
    // 依赖只留这两个。原来带着 isEditMode / editorState / editorTick / zoom ——
    // 而 applyEdit 在刷笔刷的**每个 mousemove** 都 setEditorTick，于是每个 mousemove 都
    // teardown + 重建 rAF 循环和 ResizeObserver，并重新给 canvas.width 赋值
    // （按规范这会重新分配整张 bitmap）。rAF 循环本来每帧都重画，根本不需要靠
    // 「tick 变了重建循环」来刷新，可变值走 ref 即可。
  }, [officeState, resizeCanvas, panRef])

  // Convert CSS mouse coords to world (sprite pixel) coords
  const screenToWorld = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current
      if (!canvas) return null
      const rect = canvas.getBoundingClientRect()
      const dpr = dprRef.current          // 与 resizeCanvas 同源，见那里的说明
      // CSS coords relative to canvas
      const cssX = clientX - rect.left
      const cssY = clientY - rect.top
      // Convert to device pixels
      const deviceX = cssX * dpr
      const deviceY = cssY * dpr
      // Convert to world (sprite pixel) coords
      const worldX = (deviceX - offsetRef.current.x) / zoom
      const worldY = (deviceY - offsetRef.current.y) / zoom
      return { worldX, worldY, screenX: cssX, screenY: cssY, deviceX, deviceY }
    },
    [zoom],
  )

  const screenToTile = useCallback(
    (clientX: number, clientY: number): { col: number; row: number } | null => {
      const pos = screenToWorld(clientX, clientY)
      if (!pos) return null
      const col = Math.floor(pos.worldX / TILE_SIZE)
      const row = Math.floor(pos.worldY / TILE_SIZE)
      const layout = officeState.getLayout()
      // In edit mode with floor/wall/erase tool, extend valid range by 1 for ghost border
      if (isEditMode && (editorState.activeTool === EditTool.TILE_PAINT || editorState.activeTool === EditTool.WALL_PAINT || editorState.activeTool === EditTool.ERASE)) {
        if (col < -1 || col > layout.cols || row < -1 || row > layout.rows) return null
        return { col, row }
      }
      if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return null
      return { col, row }
    },
    [screenToWorld, officeState, isEditMode, editorState],
  )

  // Check if device-pixel coords hit the delete button
  const hitTestDeleteButton = useCallback((deviceX: number, deviceY: number): boolean => {
    const bounds = deleteButtonBoundsRef.current
    if (!bounds) return false
    const dx = deviceX - bounds.cx
    const dy = deviceY - bounds.cy
    return (dx * dx + dy * dy) <= (bounds.radius + 2) * (bounds.radius + 2) // small padding
  }, [])

  // Check if device-pixel coords hit the rotate button
  const hitTestRotateButton = useCallback((deviceX: number, deviceY: number): boolean => {
    const bounds = rotateButtonBoundsRef.current
    if (!bounds) return false
    const dx = deviceX - bounds.cx
    const dy = deviceY - bounds.cy
    return (dx * dx + dy * dy) <= (bounds.radius + 2) * (bounds.radius + 2)
  }, [])

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      // Handle middle-mouse panning
      if (isPanningRef.current) {
        const dpr = window.devicePixelRatio || 1
        const dx = (e.clientX - panStartRef.current.mouseX) * dpr
        const dy = (e.clientY - panStartRef.current.mouseY) * dpr
        panRef.current = clampPan(
          panStartRef.current.panX + dx,
          panStartRef.current.panY + dy,
        )
        return
      }

      if (isEditMode) {
        const tile = screenToTile(e.clientX, e.clientY)
        if (tile) {
          editorState.ghostCol = tile.col
          editorState.ghostRow = tile.row

          // Drag-to-move: check if cursor moved to different tile
          if (editorState.dragUid && !editorState.isDragMoving) {
            if (tile.col !== editorState.dragStartCol || tile.row !== editorState.dragStartRow) {
              editorState.isDragMoving = true
            }
          }

          // Paint on drag (tile/wall/erase paint tool only, not during furniture drag)
          if (editorState.isDragging && (editorState.activeTool === EditTool.TILE_PAINT || editorState.activeTool === EditTool.WALL_PAINT || editorState.activeTool === EditTool.ERASE) && !editorState.dragUid) {
            onEditorTileAction(tile.col, tile.row)
          }
          // Right-click erase drag
          if (isEraseDraggingRef.current && (editorState.activeTool === EditTool.TILE_PAINT || editorState.activeTool === EditTool.WALL_PAINT || editorState.activeTool === EditTool.ERASE)) {
            const layout = officeState.getLayout()
            if (tile.col >= 0 && tile.col < layout.cols && tile.row >= 0 && tile.row < layout.rows) {
              onEditorEraseAction(tile.col, tile.row)
            }
          }
        } else {
          editorState.ghostCol = -1
          editorState.ghostRow = -1
        }

        // Cursor: show grab during drag, pointer over delete button, crosshair otherwise
        const canvas = canvasRef.current
        if (canvas) {
          if (editorState.isDragMoving) {
            canvas.style.cursor = 'grabbing'
          } else {
            const pos = screenToWorld(e.clientX, e.clientY)
            if (pos && (hitTestDeleteButton(pos.deviceX, pos.deviceY) || hitTestRotateButton(pos.deviceX, pos.deviceY))) {
              canvas.style.cursor = 'pointer'
            } else if (editorState.activeTool === EditTool.FURNITURE_PICK && tile) {
              // Pick mode: show pointer over furniture, crosshair elsewhere
              const layout = officeState.getLayout()
              const hitFurniture = layout.furniture.find((f) => {
                const entry = getCatalogEntry(f.type)
                if (!entry) return false
                return tile.col >= f.col && tile.col < f.col + entry.footprintW && tile.row >= f.row && tile.row < f.row + entry.footprintH
              })
              canvas.style.cursor = hitFurniture ? 'pointer' : 'crosshair'
            } else if ((editorState.activeTool === EditTool.SELECT || (editorState.activeTool === EditTool.FURNITURE_PLACE && editorState.selectedFurnitureType === '')) && tile) {
              // Check if hovering over furniture
              const layout = officeState.getLayout()
              const hitFurniture = layout.furniture.find((f) => {
                const entry = getCatalogEntry(f.type)
                if (!entry) return false
                return tile.col >= f.col && tile.col < f.col + entry.footprintW && tile.row >= f.row && tile.row < f.row + entry.footprintH
              })
              canvas.style.cursor = hitFurniture ? 'grab' : 'crosshair'
            } else {
              canvas.style.cursor = 'crosshair'
            }
          }
        }
        return
      }

      const pos = screenToWorld(e.clientX, e.clientY)
      if (!pos) return
      const hitId = officeState.getCharacterAt(pos.worldX, pos.worldY)
      const tile = screenToTile(e.clientX, e.clientY)
      officeState.hoveredTile = tile
      const canvas = canvasRef.current
      if (canvas) {
        let cursor = 'default'
        if (hitId !== null) {
          cursor = 'pointer'
        } else if (officeState.selectedAgentId !== null && tile) {
          // Check if hovering over a clickable seat (available or own)
          const seatId = officeState.getSeatAtTile(tile.col, tile.row)
          if (seatId) {
            const seat = officeState.seats.get(seatId)
            if (seat) {
              const selectedCh = officeState.characters.get(officeState.selectedAgentId)
              if (!seat.assigned || (selectedCh && selectedCh.seatId === seatId)) {
                cursor = 'pointer'
              }
            }
          }
        }
        canvas.style.cursor = cursor
      }
      officeState.hoveredAgentId = hitId
    },
    [officeState, screenToWorld, screenToTile, isEditMode, editorState, onEditorTileAction, onEditorEraseAction, panRef, hitTestDeleteButton, hitTestRotateButton, clampPan],
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      unlockAudio()
      // Middle mouse button (button 1) starts panning
      if (e.button === 1) {
        e.preventDefault()
        // Break camera follow on manual pan
        officeState.cameraFollowId = null
        isPanningRef.current = true
        panStartRef.current = {
          mouseX: e.clientX,
          mouseY: e.clientY,
          panX: panRef.current.x,
          panY: panRef.current.y,
        }
        const canvas = canvasRef.current
        if (canvas) canvas.style.cursor = 'grabbing'
        return
      }

      // Right-click in edit mode for erasing
      if (e.button === 2 && isEditMode) {
        const tile = screenToTile(e.clientX, e.clientY)
        if (tile && (editorState.activeTool === EditTool.TILE_PAINT || editorState.activeTool === EditTool.WALL_PAINT || editorState.activeTool === EditTool.ERASE)) {
          const layout = officeState.getLayout()
          if (tile.col >= 0 && tile.col < layout.cols && tile.row >= 0 && tile.row < layout.rows) {
            isEraseDraggingRef.current = true
            onEditorEraseAction(tile.col, tile.row)
          }
        }
        return
      }

      if (!isEditMode) return

      // Check rotate/delete button hit first
      const pos = screenToWorld(e.clientX, e.clientY)
      if (pos && hitTestRotateButton(pos.deviceX, pos.deviceY)) {
        onRotateSelected()
        return
      }
      if (pos && hitTestDeleteButton(pos.deviceX, pos.deviceY)) {
        onDeleteSelected()
        return
      }

      const tile = screenToTile(e.clientX, e.clientY)

      // SELECT tool (or furniture tool with nothing selected): check for furniture hit to start drag
      const actAsSelect = editorState.activeTool === EditTool.SELECT ||
        (editorState.activeTool === EditTool.FURNITURE_PLACE && editorState.selectedFurnitureType === '')
      if (actAsSelect && tile) {
        const layout = officeState.getLayout()
        // Find all furniture at clicked tile, prefer surface items (on top of desks)
        let hitFurniture = null as typeof layout.furniture[0] | null
        for (const f of layout.furniture) {
          const entry = getCatalogEntry(f.type)
          if (!entry) continue
          if (tile.col >= f.col && tile.col < f.col + entry.footprintW && tile.row >= f.row && tile.row < f.row + entry.footprintH) {
            if (!hitFurniture || entry.canPlaceOnSurfaces) hitFurniture = f
          }
        }
        if (hitFurniture) {
          // Start drag — record offset from furniture's top-left
          editorState.startDrag(
            hitFurniture.uid,
            tile.col,
            tile.row,
            tile.col - hitFurniture.col,
            tile.row - hitFurniture.row,
          )
          return
        } else {
          // Clicked empty space — deselect
          editorState.clearSelection()
          onEditorSelectionChange()
        }
      }

      // Non-select tools: start paint drag
      editorState.isDragging = true
      if (tile) {
        onEditorTileAction(tile.col, tile.row)
      }
    },
    [officeState, isEditMode, editorState, screenToTile, screenToWorld, onEditorTileAction, onEditorEraseAction, onEditorSelectionChange, onDeleteSelected, onRotateSelected, hitTestDeleteButton, hitTestRotateButton, panRef],
  )

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 1) {
        isPanningRef.current = false
        const canvas = canvasRef.current
        if (canvas) canvas.style.cursor = isEditMode ? 'crosshair' : 'default'
        return
      }
      if (e.button === 2) {
        isEraseDraggingRef.current = false
        return
      }

      // Handle drag-to-move completion
      if (editorState.dragUid) {
        if (editorState.isDragMoving) {
          // Compute target position
          const ghostCol = editorState.ghostCol - editorState.dragOffsetCol
          const ghostRow = editorState.ghostRow - editorState.dragOffsetRow
          const draggedItem = officeState.getLayout().furniture.find((f) => f.uid === editorState.dragUid)
          if (draggedItem) {
            const valid = canPlaceFurniture(
              officeState.getLayout(),
              draggedItem.type,
              ghostCol,
              ghostRow,
              editorState.dragUid,
            )
            if (valid) {
              onDragMove(editorState.dragUid, ghostCol, ghostRow)
            }
          }
          editorState.clearSelection()
        } else {
          // Click (no movement) — toggle selection
          if (editorState.selectedFurnitureUid === editorState.dragUid) {
            editorState.clearSelection()
          } else {
            editorState.selectedFurnitureUid = editorState.dragUid
          }
        }
        editorState.clearDrag()
        onEditorSelectionChange()
        const canvas = canvasRef.current
        if (canvas) canvas.style.cursor = 'crosshair'
        return
      }

      editorState.isDragging = false
      editorState.wallDragAdding = null
    },
    [editorState, isEditMode, officeState, onDragMove, onEditorSelectionChange],
  )

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (isEditMode) return // handled by mouseDown/mouseUp
      const pos = screenToWorld(e.clientX, e.clientY)
      if (!pos) return

      const hitId = officeState.getCharacterAt(pos.worldX, pos.worldY)
      if (hitId !== null) {
        // Dismiss any active bubble on click
        officeState.dismissBubble(hitId)
        // Toggle selection: click same agent deselects, different agent selects
        if (officeState.selectedAgentId === hitId) {
          officeState.selectedAgentId = null
          officeState.cameraFollowId = null
        } else {
          officeState.selectedAgentId = hitId
          officeState.cameraFollowId = hitId
        }
        onClick(hitId) // still focus terminal
        return
      }

      // No agent hit — check seat click while agent is selected
      if (officeState.selectedAgentId !== null) {
        const selectedCh = officeState.characters.get(officeState.selectedAgentId)
        // Skip seat reassignment for sub-agents
        if (selectedCh && !selectedCh.isSubagent) {
          const tile = screenToTile(e.clientX, e.clientY)
          if (tile) {
            const seatId = officeState.getSeatAtTile(tile.col, tile.row)
            if (seatId) {
              const seat = officeState.seats.get(seatId)
              if (seat && selectedCh) {
                if (selectedCh.seatId === seatId) {
                  // Clicked own seat — send agent back to it
                  officeState.sendToSeat(officeState.selectedAgentId)
                  officeState.selectedAgentId = null
                  officeState.cameraFollowId = null
                  return
                } else if (!seat.assigned) {
                  // Clicked available seat — reassign
                  officeState.reassignSeat(officeState.selectedAgentId, seatId)
                  officeState.selectedAgentId = null
                  officeState.cameraFollowId = null
                  // Persist seat assignments (exclude sub-agents)
                  const seats: Record<number, { palette: number; seatId: string | null }> = {}
                  for (const ch of officeState.characters.values()) {
                    if (ch.isSubagent) continue
                    seats[ch.id] = { palette: ch.palette, seatId: ch.seatId }
                  }
                  vscode.postMessage({ type: 'saveAgentSeats', seats })
                  return
                }
              }
            }
          }
        }
        // Clicked empty space — deselect
        officeState.selectedAgentId = null
        officeState.cameraFollowId = null
      }
    },
    [officeState, onClick, screenToWorld, screenToTile, isEditMode],
  )

  const handleMouseLeave = useCallback(() => {
    isPanningRef.current = false
    isEraseDraggingRef.current = false
    editorState.isDragging = false
    editorState.wallDragAdding = null
    editorState.clearDrag()
    editorState.ghostCol = -1
    editorState.ghostRow = -1
    officeState.hoveredAgentId = null
    officeState.hoveredTile = null
  }, [officeState, editorState])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    if (isEditMode) return
    // Right-click to walk selected agent to tile
    if (officeState.selectedAgentId !== null) {
      const tile = screenToTile(e.clientX, e.clientY)
      if (tile) {
        officeState.walkToTile(officeState.selectedAgentId, tile.col, tile.row)
      }
    }
  }, [isEditMode, officeState, screenToTile])

  // Wheel: Ctrl+wheel to zoom, plain wheel/trackpad to pan
  //
  // **必须用原生监听 + { passive: false }**（见下面的 effect）：react-dom 19 把 wheel
  // 注册成 passive 监听器，passive 里的 preventDefault() 被浏览器直接忽略 ——
  // Mac 触控板双指捏合（= Ctrl+wheel）会连整个 Dashboard 一起缩放，
  // 控制台还会一直刷 "Unable to preventDefault inside passive event listener"。
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        // Accumulate scroll delta, step zoom when threshold crossed
        zoomAccumulatorRef.current += e.deltaY
        if (Math.abs(zoomAccumulatorRef.current) >= ZOOM_SCROLL_THRESHOLD) {
          const delta = zoomAccumulatorRef.current < 0 ? 1 : -1
          zoomAccumulatorRef.current = 0
          const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom + delta))
          if (newZoom !== zoom) {
            onZoomChange(newZoom)
          }
        }
      } else {
        // Pan via trackpad two-finger scroll or mouse wheel
        const dpr = dprRef.current
        officeState.cameraFollowId = null
        panRef.current = clampPan(
          panRef.current.x - e.deltaX * dpr,
          panRef.current.y - e.deltaY * dpr,
        )
      }
    },
    [zoom, onZoomChange, officeState, panRef, clampPan],
  )

  // 手动绑 wheel：React 的 onWheel 是 passive 的，拦不住浏览器自己的缩放/滚动
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  // Prevent default middle-click browser behavior (auto-scroll)
  const handleAuxClick = useCallback((e: React.MouseEvent) => {
    if (e.button === 1) e.preventDefault()
  }, [])

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
        // 跟随应用主题（pixel-theme.js 里定义），不再硬编码深色 —— 浅色主题下
        // 画布外框原来仍是深色，和周围格格不入
        background: 'var(--pixel-bg, #1E1E2E)',
      }}
    >
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onClick={handleClick}
        onAuxClick={handleAuxClick}
        onMouseLeave={handleMouseLeave}
        onContextMenu={handleContextMenu}
        style={{ display: 'block' }}
      />
    </div>
  )
}
