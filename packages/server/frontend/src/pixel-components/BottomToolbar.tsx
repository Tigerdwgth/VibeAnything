import { useState } from 'react'
import { SettingsModal } from './SettingsModal.js'

interface BottomToolbarProps {
  isEditMode: boolean
  onOpenClaude: () => void
  onToggleEditMode: () => void
  isDebugMode: boolean
  onToggleDebugMode: () => void
}

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 10,
  left: 10,
  zIndex: 'var(--pixel-controls-z)',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  background: 'var(--pixel-bg)',
  border: '1px solid var(--pixel-border)',
  borderRadius: 6,
  padding: 3,
  boxShadow: 'var(--pixel-shadow)',
}

// 原版按 VS Code 侧栏里的像素字体定的 24px，换成本应用的无衬线字体后大得刺眼（一颗按钮
// 比小镇里的人还高），和名牌、会话列表放在一起也不成套，这里统一收成 12px
const btnBase: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: '12px',
  fontWeight: 600,
  fontFamily: 'var(--pixel-font, system-ui)',
  color: 'var(--pixel-text)',
  background: 'var(--pixel-btn-bg)',
  border: '1px solid transparent',
  borderRadius: 4,
  cursor: 'pointer',
}

const btnActive: React.CSSProperties = {
  ...btnBase,
  background: 'var(--pixel-active-bg)',
  border: '1px solid var(--pixel-accent)',
}


export function BottomToolbar({
  isEditMode,
  onOpenClaude,
  onToggleEditMode,
  isDebugMode,
  onToggleDebugMode,
}: BottomToolbarProps) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)

  // 原版的 "+ Agent" 按钮是发给 VS Code 宿主去开一个新终端的（openClaude），
  // 这个应用里没有那个宿主：点了什么都不会发生。与其留一个点了没反应的按钮，
  // 不如不显示 —— 新建会话走左侧会话列表的「新建」。onOpenClaude 仍留在接口上，
  // 等哪天把它接到 Dashboard 的 launchInDir 再放出来。
  void onOpenClaude

  return (
    <div style={panelStyle}>
      <button
        onClick={onToggleEditMode}
        onMouseEnter={() => setHovered('edit')}
        onMouseLeave={() => setHovered(null)}
        style={
          isEditMode
            ? { ...btnActive }
            : {
                ...btnBase,
                background: hovered === 'edit' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
              }
        }
        title="Edit office layout"
      >
        布局
      </button>
      <div style={{ position: 'relative' }}>
        <button
          onClick={() => setIsSettingsOpen((v) => !v)}
          onMouseEnter={() => setHovered('settings')}
          onMouseLeave={() => setHovered(null)}
          style={
            isSettingsOpen
              ? { ...btnActive }
              : {
                  ...btnBase,
                  background: hovered === 'settings' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
                }
          }
          title="Settings"
        >
          设置
        </button>
        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          isDebugMode={isDebugMode}
          onToggleDebugMode={onToggleDebugMode}
        />
      </div>
    </div>
  )
}
