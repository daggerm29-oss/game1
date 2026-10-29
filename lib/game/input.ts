export type ChoiceIntent = { kind: 'direction'; dir: 'left' | 'center' | 'right' } | { kind: 'slot'; slot: number }

/**
 * Unifies touch and keyboard. Hold-to-walk comes from the on-screen button or W / Up / Space.
 * On the canvas: swipe left/right/up picks a door, tap is raycast by the game, drag looks around.
 */
export class Input {
  private keys = new Set<string>()
  private buttonHeld = false
  private pointer: { id: number; x: number; y: number; t: number; lastX: number; lastY: number } | null = null
  look = { yaw: 0, pitch: 0 }
  onChoice: ((intent: ChoiceIntent) => void) | null = null
  onTap: ((ndcX: number, ndcY: number) => void) | null = null
  onAnyGesture: (() => void) | null = null
  private cleanup: (() => void)[] = []

  get walking() {
    return this.buttonHeld || this.keys.has('KeyW') || this.keys.has('ArrowUp') || this.keys.has('Space')
  }

  setWalkButton(held: boolean) {
    this.buttonHeld = held
    if (held) this.onAnyGesture?.()
  }

  attach(el: HTMLElement) {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return
      this.onAnyGesture?.()
      this.keys.add(e.code)
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault()
      if (e.code === 'KeyA' || e.code === 'ArrowLeft') this.onChoice?.({ kind: 'direction', dir: 'left' })
      if (e.code === 'KeyD' || e.code === 'ArrowRight') this.onChoice?.({ kind: 'direction', dir: 'right' })
      if (e.code === 'KeyW' || e.code === 'ArrowUp') this.onChoice?.({ kind: 'direction', dir: 'center' })
      if (e.code === 'Digit1') this.onChoice?.({ kind: 'slot', slot: 0 })
      if (e.code === 'Digit2') this.onChoice?.({ kind: 'slot', slot: 1 })
      if (e.code === 'Digit3') this.onChoice?.({ kind: 'slot', slot: 2 })
    }
    const onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code)
    const onBlur = () => {
      this.keys.clear()
      this.buttonHeld = false
    }

    const onPointerDown = (e: PointerEvent) => {
      this.onAnyGesture?.()
      if (this.pointer) return
      this.pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), lastX: e.clientX, lastY: e.clientY }
      el.setPointerCapture?.(e.pointerId)
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!this.pointer || this.pointer.id !== e.pointerId) return
      const dx = e.clientX - this.pointer.lastX
      const dy = e.clientY - this.pointer.lastY
      this.pointer.lastX = e.clientX
      this.pointer.lastY = e.clientY
      const scale = 2.2 / Math.max(window.innerWidth, 320)
      this.look.yaw = clamp(this.look.yaw - dx * scale, -0.9, 0.9)
      this.look.pitch = clamp(this.look.pitch - dy * scale, -0.75, 0.45)
    }
    const onPointerUp = (e: PointerEvent) => {
      if (!this.pointer || this.pointer.id !== e.pointerId) return
      const dx = e.clientX - this.pointer.x
      const dy = e.clientY - this.pointer.y
      const dt = performance.now() - this.pointer.t
      this.pointer = null
      const dist = Math.hypot(dx, dy)
      if (dist < 12 && dt < 400) {
        const rect = el.getBoundingClientRect()
        this.onTap?.(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
        return
      }
      if (dt < 450 && dist > 45) {
        if (Math.abs(dx) > Math.abs(dy)) this.onChoice?.({ kind: 'direction', dir: dx < 0 ? 'left' : 'right' })
        else if (dy < 0) this.onChoice?.({ kind: 'direction', dir: 'center' })
      }
    }

    // Stops pull-to-refresh, pinch zoom and overscroll inside the Telegram webview.
    const preventTouch = (e: TouchEvent) => {
      if (e.touches.length > 1 || (e.target as HTMLElement)?.closest?.('[data-scrollable]') === null) e.preventDefault()
    }
    const preventGesture = (e: Event) => e.preventDefault()

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', onPointerUp)
    el.addEventListener('pointercancel', onPointerUp)
    document.addEventListener('touchmove', preventTouch, { passive: false })
    document.addEventListener('gesturestart', preventGesture)

    this.cleanup.push(() => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointercancel', onPointerUp)
      document.removeEventListener('touchmove', preventTouch)
      document.removeEventListener('gesturestart', preventGesture)
    })
  }

  /** Look offsets spring back to center while no finger is down. */
  update(dt: number) {
    if (this.pointer) return
    const k = 1 - Math.exp(-dt * 2.5)
    this.look.yaw += (0 - this.look.yaw) * k
    this.look.pitch += (0 - this.look.pitch) * k
  }

  dispose() {
    this.cleanup.forEach((fn) => fn())
    this.cleanup = []
  }
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v))
}
