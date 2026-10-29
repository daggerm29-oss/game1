'use client'

import { ChevronUp } from 'lucide-react'
import { useState } from 'react'
import type { UIState } from '@/lib/game/store'
import { cn } from '@/lib/utils'

interface Props {
  state: UIState
  onWalk: (held: boolean) => void
  onChoose: (slot: number) => void
}

const DOOR_LABELS: Record<number, string[]> = {
  2: ['Left', 'Right'],
  3: ['Left', 'Middle', 'Right'],
}

export function TouchControls({ state, onWalk, onChoose }: Props) {
  const [held, setHeld] = useState(false)
  const showWalk = state.phase === 'RUN' && !state.transitioning
  const showDoors = state.phase === 'CHOOSE'

  const setWalk = (value: boolean) => {
    setHeld(value)
    onWalk(value)
  }

  return (
    <div className="safe-pad pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col items-center gap-3">
      {showWalk && (
        <button
          type="button"
          aria-label="Hold to walk forward"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            setWalk(true)
          }}
          onPointerUp={() => setWalk(false)}
          onPointerCancel={() => setWalk(false)}
          onLostPointerCapture={() => setWalk(false)}
          onContextMenu={(e) => e.preventDefault()}
          className={cn(
            'pointer-events-auto flex h-24 w-full max-w-sm touch-none flex-col items-center justify-center rounded-lg border-2 text-lg font-bold uppercase tracking-[0.3em] backdrop-blur transition',
            held
              ? 'scale-[0.98] border-primary bg-primary/25 text-primary'
              : 'border-foreground/25 bg-background/50 text-foreground',
          )}
        >
          <ChevronUp className="size-7" aria-hidden />
          {held ? 'Walking' : 'Hold to walk'}
        </button>
      )}

      {showDoors && (
        <div className="pointer-events-auto flex w-full max-w-md gap-2">
          {(DOOR_LABELS[state.doorCount] ?? DOOR_LABELS[2]).map((label, slot) => (
            <button
              key={label}
              type="button"
              disabled={!state.canChoose}
              onClick={() => onChoose(slot)}
              className="flex h-20 flex-1 items-center justify-center rounded-lg border-2 border-foreground/25 bg-background/55 text-lg font-bold uppercase tracking-[0.2em] backdrop-blur transition active:scale-95 active:border-primary disabled:opacity-40"
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {showDoors && (
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Tap a door, swipe, or use A / W / D
        </p>
      )}
      {state.awaitingVerdict && state.phase === 'CHOOSE' && (
        <p className="sr-only" aria-live="assertive">
          Checking door
        </p>
      )}
    </div>
  )
}
