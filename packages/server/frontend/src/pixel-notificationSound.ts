import {
  NOTIFICATION_NOTE_1_HZ,
  NOTIFICATION_NOTE_2_HZ,
  NOTIFICATION_NOTE_1_START_SEC,
  NOTIFICATION_NOTE_2_START_SEC,
  NOTIFICATION_NOTE_DURATION_SEC,
  NOTIFICATION_VOLUME,
} from './pixel-constants.js'
import {
  isSoundEnabled as isBrowserSoundEnabled,
  setSoundEnabled as setBrowserSoundEnabled,
} from './sound.js'

let audioCtx: AudioContext | null = null

// 提示音开关与 Dashboard 顶栏共用同一份「按浏览器记忆」的偏好（见 sound.js），
// 避免像素视图和主面板各有一个开关、关了一个另一个还在响。
export function setSoundEnabled(enabled: boolean): void {
  setBrowserSoundEnabled(enabled)
}

export function isSoundEnabled(): boolean {
  return isBrowserSoundEnabled()
}

function playNote(ctx: AudioContext, freq: number, startOffset: number): void {
  const t = ctx.currentTime + startOffset
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()

  osc.type = 'sine'
  osc.frequency.setValueAtTime(freq, t)

  gain.gain.setValueAtTime(NOTIFICATION_VOLUME, t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + NOTIFICATION_NOTE_DURATION_SEC)

  osc.connect(gain)
  gain.connect(ctx.destination)

  osc.start(t)
  osc.stop(t + NOTIFICATION_NOTE_DURATION_SEC)
}

export async function playDoneSound(): Promise<void> {
  if (!isSoundEnabled()) return
  try {
    if (!audioCtx) {
      audioCtx = new AudioContext()
    }
    // Resume suspended context (webviews suspend until user gesture)
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume()
    }
    // Ascending two-note chime: E5 → B5
    playNote(audioCtx, NOTIFICATION_NOTE_1_HZ, NOTIFICATION_NOTE_1_START_SEC)
    playNote(audioCtx, NOTIFICATION_NOTE_2_HZ, NOTIFICATION_NOTE_2_START_SEC)
  } catch {
    // Audio may not be available
  }
}

/** Call from any user-gesture handler to ensure AudioContext is unlocked */
export function unlockAudio(): void {
  try {
    if (!audioCtx) {
      audioCtx = new AudioContext()
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume()
    }
  } catch {
    // ignore
  }
}
