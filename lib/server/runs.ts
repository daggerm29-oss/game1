import 'server-only'
import type { AnswerResponse, BaseFace, DoorStep, RoundDTO, RunResult } from '@/lib/shared/game'
import { HttpError, type Player } from './auth'
import { randomId, safeEqual, sign } from './crypto'
import { bestLevel, recordBest } from './leaderboard'
import { redis } from './redis'
import { generateRound } from './rounds'
import { postResultToGroup } from './telegram-api'

const RUN_TTL_SEC = 60 * 60 * 3
/** Fastest plausible gap between door answers: walk to a gate and pick a door. */
const MIN_STEP_GAP_MS = 380
/** Fastest plausible first answer after the sign goes dark. */
const MIN_FIRST_ANSWER_MS = 700
/** Allowance for walking between gates before the per-door timer starts. */
const WALK_ALLOWANCE_MS = 45_000
const NETWORK_GRACE_MS = 4_000

interface ActiveRound {
  roundId: string
  sequence: BaseFace[]
  steps: DoorStep[]
  displayMs: number
  stepTimeMs: number
  issuedAt: number
  stepIndex: number
  lastAnswerAt: number
}

interface RunState {
  runId: string
  playerId: string
  name: string
  guest: boolean
  chatId: number | null
  level: number
  startedAt: number
  clearedAt: number
  status: 'alive' | 'dead'
  round: ActiveRound | null
  final: RunResult | null
}

const runKey = (runId: string) => `run:${runId}`

async function loadRun(runId: string, player: Player): Promise<RunState> {
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(runId)) throw new HttpError(400, 'Bad run id')
  const run = await redis().get<RunState>(runKey(runId))
  if (!run) throw new HttpError(404, 'Run expired, start again')
  if (run.playerId !== player.id) throw new HttpError(403, 'Not your run')
  return run
}

async function saveRun(run: RunState) {
  await redis().set(runKey(run.runId), run, { ex: RUN_TTL_SEC })
}

export async function startRun(player: Player, chatId: number | null) {
  const run: RunState = {
    runId: randomId(15),
    playerId: player.id,
    name: player.name,
    guest: player.guest,
    chatId: player.guest ? null : chatId,
    level: 1,
    startedAt: Date.now(),
    clearedAt: Date.now(),
    status: 'alive',
    round: null,
    final: null,
  }
  await saveRun(run)
  return run
}

function roundToken(runId: string, roundId: string, level: number, issuedAt: number) {
  return sign(`round:${runId}:${roundId}:${level}:${issuedAt}`)
}

export async function issueRound(player: Player, runId: string): Promise<RoundDTO> {
  const run = await loadRun(runId, player)
  if (run.status !== 'alive') throw new HttpError(409, 'Run is over')
  if (run.round && run.round.stepIndex < run.round.steps.length) {
    throw new HttpError(409, 'Finish the current round first')
  }

  const generated = generateRound(run.level)
  const issuedAt = Date.now()
  const roundId = randomId(9)
  run.round = {
    roundId,
    sequence: generated.sequence,
    steps: generated.steps,
    displayMs: generated.displayMs,
    stepTimeMs: generated.stepTimeMs,
    issuedAt,
    stepIndex: 0,
    lastAnswerAt: issuedAt + generated.displayMs,
  }
  await saveRun(run)

  return {
    roundId,
    token: roundToken(run.runId, roundId, run.level, issuedAt),
    level: run.level,
    sequence: generated.sequence,
    displayMs: generated.displayMs,
    stepTimeMs: generated.stepTimeMs,
    steps: generated.steps,
    modifiers: { decoys: generated.decoys, fakeSign: generated.fakeSign, blackouts: generated.blackouts },
  }
}

async function finishRun(run: RunState): Promise<RunResult> {
  run.status = 'dead'
  const timeMs = run.clearedAt - run.startedAt
  let ranked = false
  let best = run.level
  if (!run.guest) {
    await recordBest(run.playerId, run.name, run.chatId, run.level, timeMs)
    best = Math.max(await bestLevel(run.playerId), run.level)
    ranked = true
  }
  const postedToGroup = run.chatId !== null ? await postResultToGroup(run.chatId, run.name, run.level, timeMs) : false
  run.final = { level: run.level, levelsCleared: run.level - 1, timeMs, bestLevel: best, postedToGroup, ranked }
  run.round = null
  return run.final
}

export async function submitAnswer(
  player: Player,
  input: { runId: string; roundId: string; token: string; step: number; slot: number },
): Promise<AnswerResponse> {
  const run = await loadRun(input.runId, player)
  if (run.status === 'dead' && run.final) throw new HttpError(409, 'Run is over')
  const round = run.round
  if (!round || round.roundId !== input.roundId) throw new HttpError(409, 'Unknown round')
  const expectedToken = roundToken(run.runId, round.roundId, run.level, round.issuedAt)
  if (typeof input.token !== 'string' || !safeEqual(expectedToken, input.token)) {
    throw new HttpError(403, 'Invalid round token')
  }
  if (input.step !== round.stepIndex) throw new HttpError(409, 'Out of order answer')

  const now = Date.now()
  const step = round.steps[round.stepIndex]
  const isFirst = round.stepIndex === 0
  const earliest = isFirst ? round.issuedAt + round.displayMs * 0.85 + MIN_FIRST_ANSWER_MS : round.lastAnswerAt + MIN_STEP_GAP_MS
  const latest = round.lastAnswerAt + WALK_ALLOWANCE_MS + round.stepTimeMs + NETWORK_GRACE_MS

  let reason: 'wrong_door' | 'timeout' | 'implausible' | 'forfeit' | null = null
  if (input.slot === -2) reason = 'forfeit'
  else if (input.slot === -1 || now > latest) reason = 'timeout'
  else if (now < earliest) reason = 'implausible'
  else if (!Number.isInteger(input.slot) || input.slot < 0 || input.slot >= step.faces.length) reason = 'wrong_door'
  else if (step.faces[input.slot] !== round.sequence[round.stepIndex]) reason = 'wrong_door'

  if (reason) {
    const final = await finishRun(run)
    await saveRun(run)
    return { result: 'wrong', reason, final }
  }

  round.stepIndex += 1
  round.lastAnswerAt = now

  if (round.stepIndex < round.steps.length) {
    await saveRun(run)
    return { result: 'correct', roundComplete: false }
  }

  run.level += 1
  run.clearedAt = now
  if (!run.guest) await recordBest(run.playerId, run.name, run.chatId, run.level, run.clearedAt - run.startedAt)
  await saveRun(run)
  return { result: 'correct', roundComplete: true, nextLevel: run.level }
}
