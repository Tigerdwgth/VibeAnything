import { StrictMode } from 'react'
import '../motion.css'
import { createRoot } from 'react-dom/client'
import MobileApp from './MobileApp.jsx'
import { installAppHeightSync } from '../app-height.js'

// 真实可视高度 → --app-height（html/body/#root 共用）。地址栏收放与软键盘弹出都会
// 改变真实可视高度，100vh/100dvh 都量不准，详见 src/app-height.js。
installAppHeightSync()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <MobileApp />
  </StrictMode>,
)
