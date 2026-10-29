import * as THREE from 'three'
import type { AnswerResponse, RoundDTO } from '@/lib/shared/game'
import { ApiError, api } from './api'
import { AudioEngine } from './audio'
import { type ChoiceIntent, Input } from './input'
import { ResolutionScaler, TIERS, downgrade, guessTier } from './quality'
import { EYE_HEIGHT, type Gate, START_Z } from './render/level'
import { World } from './render/world'
import { type GameStore, type Phase, type QualitySetting, type Tier, createStore, initialUIState } from './store'
import { telegram } from './telegram'

const WALK_SPEED = 2.6
const QUALITY_KEY = 'skywalk-quality'

const DEMO_ROUND: Pick<RoundDTO, 'steps' | 'modifiers'> = {
  steps: [
    { faces: ['smile', 'frown'], preSwap: null },
    { faces: ['flat', 'angry', 'smile'], preSwap: null },
    { faces: ['frown', 'angry'], preSwap: null },
  ],
  modifiers: { decoys: false, fakeSign: null, blackouts: [] },
}

interface ChooseState {
  slot: number
  stage: 'approach' | 'waiting' | 'opening' | 'through' | 'failing'
  t: number
  from: THREE.Vector2
  verdict: AnswerResponse | null
}

interface FallState {
  t: number
  vx: number
  vy: number
  grounded: boolean
  spin: number
  hapticStep: number
}

class BootCancelled extends Error {}

const smooth = (t: number) => t * t * (3 - 2 * t)
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const damp = (current: number, target: number, rate: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-rate * dt))

export class Game {
  store: GameStore = createStore({ ...initialUIState })
  private world!: World
  private audio = new AudioEngine()
  private input = new Input()
  private scaler!: ResolutionScaler
  private raycaster = new THREE.Raycaster()

  private phase: Phase = 'LOADING'
  private raf = 0
  private last = 0
  private time = 0
  private destroyed = false

  private runId: string | null = null
  private round: RoundDTO | null = null
  private pendingRound: Promise<RoundDTO> | null = null
  private stepIndex = 0
  private phaseTime = 0

  private player = { x: 0, y: EYE_HEIGHT, z: START_Z, speed: 0, bob: 0, lastStepSign: 1 }
  private cam = { yaw: 0, pitch: 0, roll: 0, fov: 72 }
  private choose: ChooseState | null = null
  private chooseRemaining = 0
  private fall: FallState | null = null
  private memorizeRemaining = 0
  private blackoutTimers: number[] = []
  private stress = 0
  private fade = 1
  private fadeTarget = 0
  private transitioning = false
  private uiAccum = 0
  private bench: { frames: number; target: number; time: number; resolve: (ms: number) => void } | null = null
  private qualitySetting: QualitySetting = 'auto'
  private finalResult: (AnswerResponse & { result: 'wrong' }) | null = null

  async boot(container: HTMLElement) {
    const inTelegram = telegram.init()
    this.store.set({ inTelegram, groupLaunch: Boolean(telegram.startParam) })
    try {
      this.qualitySetting = (localStorage.getItem(QUALITY_KEY) as QualitySetting | null) ?? 'auto'
    } catch {
      this.qualitySetting = 'auto'
    }

    const progress = async (fraction: number, label: string) => {
      this.store.set({ loadingProgress: fraction, loadingLabel: label })
      // Yield so the loading screen can paint between heavy steps.
      await new Promise((r) => requestAnimationFrame(() => r(null)))
      if (this.destroyed) throw new BootCancelled()
    }

    try {
      await this.bootSteps(container, progress)
    } catch (error) {
      if (error instanceof BootCancelled) return
      console.error('[skywalk] boot failed', error)
      this.store.set({ error: error instanceof Error ? error.message : 'Failed to start the game' })
    }
  }

  private async bootSteps(container: HTMLElement, progress: (fraction: number, label: string) => Promise<void>) {

    await progress(0.05, 'Checking your device')
    const probe = document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl')
    if (!probe) {
      this.store.set({ error: 'WebGL is not available on this device.' })
      return
    }
    let tier: Tier = this.qualitySetting === 'auto' ? guessTier(probe) : this.qualitySetting
    probe.getExtension('WEBGL_lose_context')?.loseContext()

    this.world = new World(container, tier)
    this.scaler = new ResolutionScaler(TIERS[tier])
    this.world.onLightning = (distance) => {
      this.audio.thunder(distance)
      if (distance < 0.3 && this.phase !== 'MENU') telegram.impact('soft')
    }
    await this.world.init(progress)
    this.world.buildLevel(DEMO_ROUND)

    this.input.attach(container)
    this.input.onChoice = (intent) => this.handleChoice(intent)
    this.input.onTap = (x, y) => this.handleTap(x, y)
    this.input.onAnyGesture = () => this.audio.unlock()

    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)

    if (this.qualitySetting === 'auto') {
      await progress(0.85, 'Benchmarking')
      for (let attempt = 0; attempt < 2 && tier !== 'low'; attempt++) {
        const ms = await this.measure(40)
        const budget = 1000 / (TIERS[tier].targetFps * 0.8)
        if (ms <= budget) break
        tier = downgrade(tier)
        this.world.applyTier(tier)
        this.scaler.setConfig(TIERS[tier])
      }
    }
    this.store.set({ tier, qualitySetting: this.qualitySetting })
    await progress(1, 'Ready')
    this.setPhase('MENU')
    this.fadeTarget = 0
  }

  /** Average frame time in ms over `frames` frames, skipping a short warm-up. */
  private measure(frames: number) {
    return new Promise<number>((resolve) => {
      this.bench = { frames: -5, target: frames, time: 0, resolve }
    })
  }

  setQuality(setting: QualitySetting) {
    this.qualitySetting = setting
    try {
      localStorage.setItem(QUALITY_KEY, setting)
    } catch {}
    const tier = setting === 'auto' ? guessTier(this.world.gl) : setting
    this.world.applyTier(tier)
    this.scaler.setConfig(TIERS[tier])
    this.store.set({ qualitySetting: setting, tier })
  }

  setWalkButton(held: boolean) {
    this.input.setWalkButton(held)
  }

  chooseSlot(slot: number) {
    this.handleChoice({ kind: 'slot', slot })
  }

  setMuted(muted: boolean) {
    this.audio.setMuted(muted)
  }

  // ---------- Run flow ----------

  async startRun() {
    if (this.store.get().busy) return
    this.audio.unlock()
    this.store.set({ busy: true, error: null, result: null, overlay: 'none' })
    try {
      const run = await api.startRun()
      this.runId = run.runId
      this.store.set({ guest: run.guest, groupLaunch: run.groupLaunch, playerName: run.player.name })
      this.pendingRound = api.round(run.runId)
      telegram.setClosingConfirmation(true)
      await this.beginTransition()
    } catch (error) {
      this.showError(error)
    } finally {
      this.store.set({ busy: false })
    }
  }

  quitToMenu() {
    this.runId = null
    this.round = null
    this.pendingRound = null
    this.clearBlackouts()
    telegram.setClosingConfirmation(false)
    this.audio.setMuffled(false)
    this.audio.setHeartRate(0)
    this.world.buildLevel(DEMO_ROUND)
    this.store.set({ result: null, overlay: 'none' })
    this.setPhase('MENU')
  }

  private showError(error: unknown) {
    const message = error instanceof ApiError || error instanceof Error ? error.message : 'Something went wrong'
    this.store.set({ error: message })
    this.quitToMenu()
  }

  /** Fade out, build the next level from the (pre)fetched round, fade in, memorize. */
  private async beginTransition() {
    if (this.transitioning || !this.runId) return
    this.transitioning = true
    this.store.set({ transitioning: true })
    this.fadeTarget = 1
    let round: RoundDTO
    try {
      const pending = this.pendingRound ?? api.round(this.runId)
      ;[round] = await Promise.all([pending, new Promise((r) => setTimeout(r, 550))])
    } catch (error) {
      this.transitioning = false
      this.store.set({ transitioning: false })
      this.showError(error)
      return
    } finally {
      this.pendingRound = null
    }
    if (this.destroyed || !this.runId) {
      this.transitioning = false
      return
    }
    this.round = round
    this.stepIndex = 0
    this.world.blackout = false
    this.world.buildLevel(round)
    this.player = { x: 0, y: EYE_HEIGHT, z: START_Z, speed: 0, bob: 0, lastStepSign: 1 }
    this.cam.roll = 0
    this.fadeTarget = 0
    this.transitioning = false
    this.store.set({
      transitioning: false,
      level: round.level,
      stepIndex: 0,
      stepCount: round.steps.length,
    })
    this.audio.setWind(Math.min(1, 0.3 + round.level * 0.06))
    this.setPhase('MEMORIZE')
  }

  private setPhase(phase: Phase) {
    this.phase = phase
    this.phaseTime = 0
    const level = this.world.level
    const round = this.round

    switch (phase) {
      case 'MENU':
        this.fadeTarget = 0
        this.stress = 0
        this.audio.setHeartRate(0)
        this.audio.setWind(0.35)
        this.store.set({ hint: '', canChoose: false, awaitingVerdict: false, blackout: false })
        break
      case 'MEMORIZE':
        if (level && round) {
          level.sign.show(round.sequence)
          level.sign.target = 1
          level.sign.flicker = 0
          if (level.fakeSign) {
            level.fakeSign.target = 1
            level.fakeSign.flicker = 1
          }
        }
        this.memorizeRemaining = (round?.displayMs ?? 3000) / 1000
        this.audio.signOn()
        this.audio.setMuffled(true)
        telegram.impact('heavy')
        this.store.set({ hint: 'Memorize the sequence', canChoose: false })
        break
      case 'RUN':
        this.store.set({
          hint: this.stepIndex === 0 ? 'Hold to walk' : '',
          canChoose: false,
          awaitingVerdict: false,
          stepIndex: this.stepIndex,
        })
        break
      case 'CHOOSE':
        this.enterChoose()
        break
      case 'FALL':
        this.audio.fall()
        telegram.impact('heavy')
        this.store.set({ hint: '', canChoose: false, awaitingVerdict: false })
        break
      case 'RESULT':
        this.audio.impact()
        telegram.notify('error')
        telegram.setClosingConfirmation(false)
        this.clearBlackouts()
        this.world.blackout = false
        if (this.finalResult) {
          this.store.set({ result: { ...this.finalResult.final, reason: this.finalResult.reason } })
        }
        this.runId = null
        this.world.buildLevel(DEMO_ROUND)
        this.fadeTarget = 0.35
        break
    }
    this.store.set({ phase })
  }

  private get currentGate(): Gate | null {
    return this.world.level?.gates[this.stepIndex] ?? null
  }

  private enterChoose() {
    const gate = this.currentGate
    const round = this.round
    if (!gate || !round) return
    this.chooseRemaining = round.stepTimeMs / 1000
    this.choose = null
    const swapping = gate.swapT < 1
    gate.swapping = swapping
    if (swapping) {
      this.audio.creak(1)
      telegram.impact('rigid')
    }
    this.store.set({
      canChoose: !swapping,
      awaitingVerdict: false,
      doorCount: gate.doors.length,
      hint: swapping ? 'The doors are moving' : 'Choose a door',
    })
    this.clearBlackouts()
    for (const blackout of round.modifiers.blackouts.filter((b) => b.step === this.stepIndex)) {
      this.blackoutTimers.push(
        window.setTimeout(() => {
          this.world.blackout = true
          this.world.strikeSoon(0.25)
          this.audio.signOff()
          this.store.set({ blackout: true })
          telegram.impact('medium')
        }, blackout.delayMs),
        window.setTimeout(() => {
          this.world.blackout = false
          this.store.set({ blackout: false })
        }, blackout.delayMs + blackout.durationMs),
      )
    }
  }

  private clearBlackouts() {
    this.blackoutTimers.forEach((id) => window.clearTimeout(id))
    this.blackoutTimers = []
    if (this.world) this.world.blackout = false
    this.store.set({ blackout: false })
  }

  private handleChoice(intent: ChoiceIntent) {
    if (this.phase !== 'CHOOSE' || !this.store.get().canChoose) return
    const gate = this.currentGate
    if (!gate) return
    const n = gate.doors.length
    let slot: number | null = null
    if (intent.kind === 'slot') slot = intent.slot < n ? intent.slot : null
    else if (intent.dir === 'left') slot = 0
    else if (intent.dir === 'right') slot = n - 1
    else if (n === 3) slot = 1
    if (slot === null) return
    this.submit(slot)
  }

  private handleTap(x: number, y: number) {
    if (this.phase !== 'CHOOSE' || !this.store.get().canChoose) return
    const gate = this.currentGate
    if (!gate) return
    this.raycaster.setFromCamera(new THREE.Vector2(x, y), this.world.camera)
    const hits = this.raycaster.intersectObjects(
      gate.doors.map((d) => d.root),
      true,
    )
    for (const hit of hits) {
      let obj: THREE.Object3D | null = hit.object
      while (obj) {
        const door = gate.doors.find((d) => d.root === obj)
        if (door) {
          this.submit(door.slot)
          return
        }
        obj = obj.parent
      }
    }
  }

  private submit(slot: number) {
    const round = this.round
    if (!round || !this.runId || this.choose) return
    telegram.selection()
    this.choose = { slot, stage: 'approach', t: 0, from: new THREE.Vector2(this.player.x, this.player.z), verdict: null }
    this.store.set({ canChoose: false, awaitingVerdict: true, hint: '' })
    const step = this.stepIndex
    api
      .answer({ runId: this.runId, roundId: round.roundId, token: round.token, step, slot })
      .then((verdict) => {
        if (this.choose && this.stepIndex === step) this.choose.verdict = verdict
        if (verdict.result === 'correct' && verdict.roundComplete && this.runId) {
          this.pendingRound = api.round(this.runId)
          this.pendingRound.catch(() => {})
        }
      })
      .catch((error) => this.showError(error))
  }

  // ---------- Frame loop ----------

  private frame = (now: number) => {
    if (this.destroyed) return
    this.raf = requestAnimationFrame(this.frame)
    const dt = Math.min(0.05, Math.max(0.001, (now - this.last) / 1000))
    this.last = now
    this.time += dt
    this.phaseTime += dt

    if (this.bench) {
      this.bench.frames += 1
      if (this.bench.frames > 0) this.bench.time += dt
      if (this.bench.frames >= this.bench.target) {
        const ms = (this.bench.time / this.bench.frames) * 1000
        const { resolve } = this.bench
        this.bench = null
        resolve(ms)
      }
    }

    this.input.update(dt)
    this.updatePhase(dt)
    this.updateDoors(dt)
    this.updateCamera(dt)
    this.fade = damp(this.fade, this.fadeTarget, this.fadeTarget > this.fade ? 7 : 3, dt)

    this.world.update(dt, this.time, this.player.z)
    this.world.render(this.time, this.stress, this.fade)

    const ratio = this.scaler.sample(dt)
    if (ratio !== null) this.world.setPixelRatio(ratio)
    if (
      this.qualitySetting === 'auto' &&
      this.scaler.slowStreak >= 4 &&
      this.world.tier !== 'low' &&
      (this.phase === 'MENU' || this.phase === 'RUN' || this.phase === 'RESULT')
    ) {
      const tier = downgrade(this.world.tier)
      this.world.applyTier(tier)
      this.scaler.setConfig(TIERS[tier])
      this.store.set({ tier })
    }

    this.uiAccum += dt
    if (this.uiAccum > 0.08) {
      this.uiAccum = 0
      const round = this.round
      let timerFrac = 1
      let timerSeconds = 0
      if (this.phase === 'MEMORIZE' && round) {
        timerFrac = clamp01(this.memorizeRemaining / (round.displayMs / 1000))
        timerSeconds = this.memorizeRemaining
      } else if (this.phase === 'CHOOSE' && round) {
        timerFrac = clamp01(this.chooseRemaining / (round.stepTimeMs / 1000))
        timerSeconds = this.chooseRemaining
      }
      this.store.set({
        timerFrac: Math.round(timerFrac * 100) / 100,
        timerSeconds: Math.ceil(timerSeconds),
        stress: Math.round(this.stress * 20) / 20,
        fps: Math.round(this.scaler.fps),
      })
    }
  }

  private updatePhase(dt: number) {
    const level = this.world.level
    const round = this.round
    switch (this.phase) {
      case 'MENU':
      case 'RESULT':
      case 'LOADING':
        this.stress = damp(this.stress, 0, 2, dt)
        break

      case 'MEMORIZE': {
        this.memorizeRemaining -= dt
        const total = (round?.displayMs ?? 3000) / 1000
        this.stress = 0.2 + 0.4 * (1 - clamp01(this.memorizeRemaining / total))
        this.audio.setHeartRate(70 + this.stress * 60)
        if (this.memorizeRemaining <= 0 && level) {
          level.sign.target = 0
          level.sign.flicker = 0.6
          if (level.fakeSign) level.fakeSign.target = 0
          this.audio.signOff()
          this.audio.setMuffled(false)
          telegram.impact('light')
          this.setPhase('RUN')
        }
        break
      }

      case 'RUN': {
        if (!level || !round) break
        if (this.transitioning) break
        const walking = this.input.walking
        this.player.speed = damp(this.player.speed, walking ? WALK_SPEED : 0, walking ? 6 : 10, dt)
        const atEnd = this.stepIndex >= round.steps.length
        const stop = atEnd ? level.endPlatformZ : level.stopZ(this.stepIndex)
        this.player.z = Math.max(stop, this.player.z - this.player.speed * dt)
        this.player.x = damp(this.player.x, 0, 3, dt)
        this.stress = damp(this.stress, 0.15 + (level.halfWidthAt(this.player.z) < 1 ? 0.15 : 0), 2, dt)
        this.audio.setHeartRate(70 + this.stress * 50)
        if (this.player.speed > 0.3 && this.stepIndex === 0) this.store.set({ hint: '' })
        if (this.player.z <= stop + 0.001) {
          this.player.speed = 0
          if (atEnd) {
            telegram.notify('success')
            void this.beginTransition()
          } else {
            this.setPhase('CHOOSE')
          }
        }
        break
      }

      case 'CHOOSE':
        this.updateChoose(dt)
        break

      case 'FALL':
        this.updateFall(dt)
        break
    }
  }

  private updateChoose(dt: number) {
    const gate = this.currentGate
    const round = this.round
    if (!gate || !round) return

    if (gate.swapping) {
      gate.swapT = Math.min(1, gate.swapT + dt / 0.9)
      if (gate.swapT >= 1) {
        gate.swapping = false
        this.store.set({ canChoose: !this.choose, hint: 'Choose a door' })
      }
    }

    if (!this.choose) {
      if (!gate.swapping) this.chooseRemaining -= dt
      const frac = clamp01(this.chooseRemaining / (round.stepTimeMs / 1000))
      this.stress = damp(this.stress, 0.3 + (1 - frac) * 0.7, 4, dt)
      this.audio.setHeartRate(80 + this.stress * 100)
      if (this.chooseRemaining <= 0 && !gate.swapping) this.submit(-1)
      return
    }

    const c = this.choose
    c.t += dt
    const door = c.slot >= 0 ? gate.doors[c.slot] : null

    switch (c.stage) {
      case 'approach': {
        if (door) {
          const k = smooth(clamp01(c.t / 0.55))
          this.player.x = THREE.MathUtils.lerp(c.from.x, door.x, k)
          this.player.z = THREE.MathUtils.lerp(c.from.y, gate.z + 0.75, k)
          this.player.speed = k < 1 ? 1.5 : 0
        }
        if (c.t >= 0.55 || !door) {
          c.stage = 'waiting'
          c.t = 0
        }
        break
      }
      case 'waiting': {
        if (!c.verdict) {
          this.stress = damp(this.stress, 0.9, 3, dt)
          break
        }
        if (c.verdict.result === 'correct') {
          c.stage = 'opening'
          this.audio.doorOpen()
          this.audio.correct()
          telegram.notify('success')
        } else {
          this.finalResult = c.verdict
          c.stage = 'failing'
          this.audio.wrong()
          telegram.notify('error')
          if (door) door.rattle = 1
        }
        c.t = 0
        break
      }
      case 'opening': {
        if (door) door.openT = Math.min(1, door.openT + dt / 0.45)
        if (c.t >= 0.4) {
          c.stage = 'through'
          c.t = 0
          c.from.set(this.player.x, this.player.z)
        }
        break
      }
      case 'through': {
        const k = clamp01(c.t / 1.1)
        const doorX = door?.x ?? 0
        if (k < 0.5) {
          const a = smooth(k / 0.5)
          this.player.x = THREE.MathUtils.lerp(c.from.x, doorX, a)
          this.player.z = THREE.MathUtils.lerp(c.from.y, gate.z - 0.7, a)
        } else {
          const a = smooth((k - 0.5) / 0.5)
          this.player.x = THREE.MathUtils.lerp(doorX, 0, a)
          this.player.z = THREE.MathUtils.lerp(gate.z - 0.7, gate.z - 1.55, a)
        }
        this.player.speed = 1.8
        this.stress = damp(this.stress, 0.15, 3, dt)
        if (k >= 1) {
          const verdict = c.verdict
          this.choose = null
          this.stepIndex += 1
          if (verdict?.result === 'correct' && verdict.roundComplete) this.store.set({ level: verdict.nextLevel })
          this.setPhase('RUN')
        }
        break
      }
      case 'failing': {
        if (door && c.t > 0.15 && door.trapT === 0) door.trapT = 0.001
        if (c.t > 0.3 || !door) {
          const timeout = !door
          const side = Math.random() < 0.5 ? -1 : 1
          this.fall = {
            t: 0,
            vx: timeout ? side * 2.6 : (Math.random() - 0.5) * 0.4,
            vy: 0,
            grounded: timeout,
            spin: (Math.random() - 0.5) * 1.6,
            hapticStep: 0,
          }
          this.choose = null
          this.setPhase('FALL')
        }
        break
      }
    }
  }

  private updateFall(dt: number) {
    const f = this.fall
    const level = this.world.level
    if (!f || !level) return
    f.t += dt
    this.stress = 1
    if (f.grounded) {
      // Pushed over the edge by a gust.
      this.player.x += f.vx * dt
      f.vx *= 1 + dt * 1.5
      if (Math.abs(this.player.x) > level.halfWidthAt(this.player.z) + 0.1) f.grounded = false
    } else {
      f.vy = Math.max(-58, f.vy - 9.81 * 1.25 * dt)
      this.player.y += f.vy * dt
      this.player.x += f.vx * dt
    }
    const pulses = [0, 0.5, 1.0, 1.5]
    if (f.hapticStep < pulses.length && f.t >= pulses[f.hapticStep]) {
      telegram.impact(f.hapticStep === 0 ? 'heavy' : 'rigid')
      f.hapticStep += 1
    }
    if (f.t > 2.3) this.fadeTarget = 1
    if (f.t > 3.0 && this.fade > 0.9) {
      this.fall = null
      this.audio.resetAfterFall()
      this.setPhase('RESULT')
    }
  }

  private updateDoors(dt: number) {
    const level = this.world.level
    if (!level) return
    for (const gate of level.gates) {
      const k = smooth(clamp01(gate.swapT))
      for (const door of gate.doors) {
        if (door.trapT > 0 && door.trapT < 1) door.trapT = Math.min(1, door.trapT + dt / 0.22)
        door.root.position.x = THREE.MathUtils.lerp(door.fromX, door.x, k)
        door.panelPivot.rotation.y = smooth(door.openT) * 1.55
        door.trapPivot.rotation.x = smooth(door.trapT) * 1.75
        if (door.rattle > 0) {
          door.rattle = Math.max(0, door.rattle - dt * 2)
          door.panelPivot.rotation.y = Math.sin(this.time * 70) * 0.03 * door.rattle
        }
      }
    }
  }

  private updateCamera(dt: number) {
    const cam = this.world.camera
    const p = this.player
    const level = this.world.level
    const round = this.round
    const wind = Math.min(1, 0.3 + (round?.level ?? 1) * 0.06)

    let yaw = this.input.look.yaw
    let pitch = this.input.look.pitch
    let px = p.x
    let py = p.y
    let pz = p.z
    let fov = 72 - this.stress * 14

    if (this.phase === 'MENU' || this.phase === 'RESULT' || this.phase === 'LOADING') {
      px = 3.6
      py = EYE_HEIGHT
      pz = -2.2
      yaw += -0.55 + Math.sin(this.time * 0.07) * 0.45
      pitch += -0.42 + Math.sin(this.time * 0.11) * 0.06
      fov = 70
    } else if (this.phase === 'FALL' && this.fall) {
      const k = smooth(clamp01(this.fall.t / 1.1))
      pitch = THREE.MathUtils.lerp(pitch - 0.1, -1.35, k)
      yaw += this.fall.spin * this.fall.t * 0.4
      this.cam.roll += this.fall.spin * dt * 0.6
      fov = THREE.MathUtils.lerp(70, 102, k)
    } else {
      if (this.phase === 'MEMORIZE') {
        pitch += Math.atan2(3.05 - EYE_HEIGHT, START_Z + 2.4) * smooth(clamp01(this.phaseTime / 0.6))
      } else {
        const narrow = level && level.halfWidthAt(p.z) < 1
        pitch += narrow ? -0.2 : -0.08
        if (this.phase === 'CHOOSE') pitch += 0.1
      }
      // Head bob and footsteps.
      if (p.speed > 0.05) {
        p.bob += p.speed * dt * 4.2
        const sign = Math.sign(Math.sin(p.bob))
        if (sign !== p.lastStepSign) {
          p.lastStepSign = sign
          this.audio.footstep()
        }
      }
      const bobAmt = Math.min(1, p.speed / WALK_SPEED)
      py += Math.abs(Math.sin(p.bob)) * 0.05 * bobAmt - 0.025 * bobAmt
      px += Math.sin(p.bob * 0.5) * 0.025 * bobAmt
    }

    // Wind sway, stronger at higher levels.
    const t = this.time
    const sway = (Math.sin(t * 0.7) * 0.6 + Math.sin(t * 1.9 + 1.2) * 0.3 + Math.sin(t * 4.3) * 0.1) * wind
    let roll = sway * 0.012
    px += Math.sin(t * 0.53) * 0.018 * wind

    // Edge shake: worse the closer you are to open air.
    if (level && this.phase !== 'MENU' && this.phase !== 'RESULT' && this.phase !== 'FALL') {
      const margin = level.halfWidthAt(p.z) - Math.abs(p.x)
      const edge = clamp01((0.8 - margin) / 0.8)
      const shake = edge * 0.012 + this.stress * 0.004
      px += (Math.random() - 0.5) * shake
      py += (Math.random() - 0.5) * shake
      roll += (Math.random() - 0.5) * shake * 0.6
    }
    if (this.phase === 'FALL') {
      px += (Math.random() - 0.5) * 0.08
      py += (Math.random() - 0.5) * 0.08
      roll += this.cam.roll
    } else {
      this.cam.roll = 0
    }

    this.cam.yaw = damp(this.cam.yaw, yaw, 10, dt)
    this.cam.pitch = damp(this.cam.pitch, pitch, 8, dt)
    this.cam.fov = damp(this.cam.fov, fov, 4, dt)
    cam.position.set(px, py, pz)
    cam.rotation.set(this.cam.pitch, this.cam.yaw, roll, 'YXZ')
    if (Math.abs(cam.fov - this.cam.fov) > 0.01) {
      cam.fov = this.cam.fov
      cam.updateProjectionMatrix()
    }
  }

  destroy() {
    this.destroyed = true
    cancelAnimationFrame(this.raf)
    this.clearBlackouts()
    this.input.dispose()
    this.audio.setHeartRate(0)
    this.world?.dispose()
  }
}
