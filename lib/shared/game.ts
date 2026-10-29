export const BASE_FACES = ['smile', 'frown', 'flat', 'angry'] as const
export type BaseFace = (typeof BASE_FACES)[number]

export const DECOY_FACES = ['smirk', 'worried', 'meh', 'grumpy'] as const
export type DecoyFace = (typeof DECOY_FACES)[number]

export type Face = BaseFace | DecoyFace

export const DECOY_OF: Record<BaseFace, DecoyFace> = {
  smile: 'smirk',
  frown: 'worried',
  flat: 'meh',
  angry: 'grumpy',
}

export const FACE_EMOJI: Record<Face, string> = {
  smile: '😁',
  frown: '☹️',
  flat: '😐',
  angry: '😠',
  smirk: '🙂',
  worried: '😟',
  meh: '😑',
  grumpy: '😤',
}

export interface DoorStep {
  /** Face shown above each door slot, left to right, after any swap. */
  faces: Face[]
  /** Layout shown before the swap animation, when the doors swap positions. */
  preSwap: Face[] | null
}

export interface Blackout {
  step: number
  delayMs: number
  durationMs: number
}

export interface RoundModifiers {
  decoys: boolean
  fakeSign: BaseFace[] | null
  blackouts: Blackout[]
}

export interface RoundDTO {
  roundId: string
  token: string
  level: number
  sequence: BaseFace[]
  displayMs: number
  stepTimeMs: number
  steps: DoorStep[]
  modifiers: RoundModifiers
}

export interface RunStartResponse {
  runId: string
  guest: boolean
  groupLaunch: boolean
  player: { name: string }
}

export interface RunResult {
  level: number
  levelsCleared: number
  timeMs: number
  bestLevel: number
  postedToGroup: boolean
  ranked: boolean
}

export type AnswerResponse =
  | { result: 'correct'; roundComplete: false }
  | { result: 'correct'; roundComplete: true; nextLevel: number }
  | { result: 'wrong'; reason: 'wrong_door' | 'timeout' | 'implausible' | 'forfeit'; final: RunResult }

export interface LeaderboardEntry {
  rank: number
  name: string
  level: number
  timeMs: number
  isMe: boolean
}

export interface LeaderboardResponse {
  scope: 'global' | 'group'
  entries: LeaderboardEntry[]
  me: LeaderboardEntry | null
}

export function sequenceLength(level: number) {
  return Math.min(3 + Math.floor((level - 1) * 0.75), 12)
}

export function displayTimeMs(level: number) {
  const perFace = Math.max(420, 1100 - (level - 1) * 70)
  return sequenceLength(level) * perFace + 700
}

export function stepTimeMs(level: number) {
  return Math.max(2600, 6500 - (level - 1) * 320)
}

export function doorCountRange(level: number): [number, number] {
  if (level <= 2) return [2, 2]
  if (level <= 5) return [2, 3]
  return [3, 3]
}

export const HARD_MODE_LEVEL = 5
