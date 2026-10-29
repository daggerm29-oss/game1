import type { UIState } from '@/lib/game/store'
import { cn } from '@/lib/utils'

export function Hud({ state }: { state: UIState }) {
  const timed = state.phase === 'MEMORIZE' || state.phase === 'CHOOSE'
  const urgent = state.phase === 'CHOOSE' && state.timerFrac < 0.35
  return (
    <div className="safe-pad pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Level</span>
          <span className="text-4xl font-extrabold leading-none">{state.level}</span>
        </div>
        <ol className="flex items-center gap-1.5" aria-label={`Door ${state.stepIndex + 1} of ${state.stepCount}`}>
          {Array.from({ length: state.stepCount }, (_, i) => (
            <li
              key={i}
              className={cn(
                'h-2 w-5 rounded-[1px]',
                i < state.stepIndex ? 'bg-primary' : i === state.stepIndex ? 'bg-foreground' : 'bg-foreground/20',
              )}
            />
          ))}
        </ol>
      </div>

      {timed && (
        <div className="flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/15">
            <div
              className={cn('h-full transition-[width] duration-100 ease-linear', urgent ? 'bg-danger' : 'bg-primary')}
              style={{ width: `${state.timerFrac * 100}%` }}
            />
          </div>
          <span className={cn('w-6 text-right font-mono text-sm tabular-nums', urgent && 'text-danger')}>
            {state.timerSeconds}
          </span>
        </div>
      )}

      <div className="flex min-h-8 justify-center pt-1" aria-live="polite">
        {state.blackout ? (
          <span className="rounded-sm bg-danger/90 px-3 py-1 text-sm font-bold uppercase tracking-[0.3em] text-white">
            Power failure
          </span>
        ) : state.hint ? (
          <span className="rounded-sm bg-background/60 px-3 py-1 text-base font-semibold uppercase tracking-[0.25em] backdrop-blur">
            {state.hint}
          </span>
        ) : null}
      </div>
    </div>
  )
}
