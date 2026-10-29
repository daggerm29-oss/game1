import type { RunResult } from '@/lib/shared/game'

export type Phase = 'LOADING' | 'MENU' | 'MEMORIZE' | 'RUN' | 'CHOOSE' | 'FALL' | 'RESULT'
export type Tier = 'low' | 'medium' | 'high'
export type QualitySetting = 'auto' | Tier
export type Overlay = 'none' | 'leaderboard' | 'settings'

export interface UIState {
  phase: Phase
  overlay: Overlay
  loadingProgress: number
  loadingLabel: string
  level: number
  stepIndex: number
  stepCount: number
  doorCount: number
  /** 1 = full time left, 0 = expired. */
  timerFrac: number
  timerSeconds: number
  stress: number
  canChoose: boolean
  awaitingVerdict: boolean
  hint: string
  blackout: boolean
  transitioning: boolean
  tier: Tier
  qualitySetting: QualitySetting
  fps: number
  inTelegram: boolean
  guest: boolean
  groupLaunch: boolean
  playerName: string
  result: (RunResult & { reason: string }) | null
  error: string | null
  busy: boolean
}

type Listener = () => void

export function createStore(initial: UIState) {
  let state = initial
  const listeners = new Set<Listener>()
  return {
    get: () => state,
    set(patch: Partial<UIState>) {
      let changed = false
      for (const key in patch) {
        if (!Object.is(state[key as keyof UIState], patch[key as keyof UIState])) {
          changed = true
          break
        }
      }
      if (!changed) return
      state = { ...state, ...patch }
      listeners.forEach((listener) => listener())
    },
    subscribe(listener: Listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export type GameStore = ReturnType<typeof createStore>

export const initialUIState: UIState = {
  phase: 'LOADING',
  overlay: 'none',
  loadingProgress: 0,
  loadingLabel: 'Preparing',
  level: 1,
  stepIndex: 0,
  stepCount: 0,
  doorCount: 2,
  timerFrac: 1,
  timerSeconds: 0,
  stress: 0,
  canChoose: false,
  awaitingVerdict: false,
  hint: '',
  blackout: false,
  transitioning: false,
  tier: 'medium',
  qualitySetting: 'auto',
  fps: 60,
  inTelegram: false,
  guest: true,
  groupLaunch: false,
  playerName: '',
  result: null,
  error: null,
  busy: false,
}
