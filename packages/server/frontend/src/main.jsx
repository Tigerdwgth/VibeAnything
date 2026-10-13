import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { installAppHeightSync } from './app-height.js'

// 真实可视高度 → --app-height（html/body/#app 共用）。实现与手机版入口共用同一份，
// 见 src/app-height.js 顶部说明。
installAppHeightSync()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
