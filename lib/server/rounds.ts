import 'server-only'
import {
  BASE_FACES,
  type BaseFace,
  type Blackout,
  DECOY_OF,
  type DoorStep,
  type Face,
  HARD_MODE_LEVEL,
  displayTimeMs,
  doorCountRange,
  sequenceLength,
  stepTimeMs,
} from '@/lib/shared/game'
import { chance, randInt, shuffle } from './crypto'

export interface GeneratedRound {
  sequence: BaseFace[]
  displayMs: number
  stepTimeMs: number
  steps: DoorStep[]
  decoys: boolean
  fakeSign: BaseFace[] | null
  blackouts: Blackout[]
}

function pick<T>(items: readonly T[]) {
  return items[randInt(items.length)]
}

function generateSequence(length: number): BaseFace[] {
  const seq: BaseFace[] = []
  for (let i = 0; i < length; i++) {
    let face = pick(BASE_FACES)
    // Avoid three identical faces in a row, which reads as a glitch rather than a challenge.
    while (i >= 2 && seq[i - 1] === face && seq[i - 2] === face) face = pick(BASE_FACES)
    seq.push(face)
  }
  return seq
}

export function generateRound(level: number): GeneratedRound {
  const length = sequenceLength(level)
  const sequence = generateSequence(length)
  const hard = level >= HARD_MODE_LEVEL
  const decoys = hard && chance(0.6)
  const swapChance = hard ? Math.min(0.25 + (level - HARD_MODE_LEVEL) * 0.06, 0.6) : 0
  const [minDoors, maxDoors] = doorCountRange(level)

  const steps: DoorStep[] = sequence.map((correct) => {
    const count = minDoors + randInt(maxDoors - minDoors + 1)
    const others = shuffle(BASE_FACES.filter((f) => f !== correct))
    const wrong: Face[] = others.slice(0, count - 1)
    if (decoys && wrong.length > 0 && chance(0.7)) wrong[0] = DECOY_OF[correct]
    const faces = shuffle<Face>([correct, ...wrong])
    let preSwap: Face[] | null = null
    if (chance(swapChance)) {
      let candidate = shuffle(faces)
      for (let i = 0; i < 4 && candidate.every((f, idx) => f === faces[idx]); i++) candidate = shuffle(faces)
      if (!candidate.every((f, idx) => f === faces[idx])) preSwap = candidate
    }
    return { faces, preSwap }
  })

  const fakeSign = hard && chance(0.35) ? generateSequence(length) : null

  const blackouts: Blackout[] = []
  if (hard && chance(0.45)) {
    const count = 1 + (level >= 8 ? randInt(2) : 0)
    const used = new Set<number>()
    for (let i = 0; i < count && used.size < length; i++) {
      let step = randInt(length)
      while (used.has(step)) step = randInt(length)
      used.add(step)
      blackouts.push({ step, delayMs: 250 + randInt(900), durationMs: 1200 + randInt(1000) })
    }
  }

  return {
    sequence,
    displayMs: displayTimeMs(level),
    stepTimeMs: stepTimeMs(level),
    steps,
    decoys,
    fakeSign,
    blackouts,
  }
}
