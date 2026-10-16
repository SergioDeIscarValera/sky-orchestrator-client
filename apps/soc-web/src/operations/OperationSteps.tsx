import { Check, X } from 'lucide-react'

import type { OperationState } from '../backend/backend'
import { STEP_WORDS, stepsOf, type StepState } from './journey'

/** Each step's mark: filled once done, ringed while current, pulsing while it runs on its own. */
const MARK: Readonly<Record<StepState, string>> = {
  done: 'bg-success text-on-primary',
  current: 'border-primary text-primary-emphasis border-2',
  running: 'bg-primary text-on-primary animate-pulse motion-reduce:animate-none',
  todo: 'border-border text-muted border',
  'ended-well': 'bg-success text-on-primary',
  'ended-badly': 'bg-danger text-on-primary',
}

const WORD: Readonly<Record<StepState, string>> = {
  done: 'text-muted',
  current: 'text-heading font-semibold',
  running: 'text-heading font-semibold',
  todo: 'text-muted',
  'ended-well': 'text-heading font-semibold',
  'ended-badly': 'text-danger-emphasis font-semibold',
}

/** What a screen reader hears after each step's name. */
const SPOKEN: Readonly<Record<StepState, string>> = {
  done: 'done',
  current: 'current step',
  running: 'in progress',
  todo: 'to come',
  'ended-well': 'completed',
  'ended-badly': 'ended without completing',
}

/**
 * The operation's five steps in a row (FR-OPS-02): where it is, what is done and what comes next.
 * The words carry the meaning; the marks only repeat it.
 */
export function OperationSteps({ state }: { readonly state: OperationState }) {
  return (
    <ol aria-label="Steps" className="mt-4 flex items-start justify-between gap-1">
      {stepsOf(state).map(({ step, state: stepState }, index) => (
        <li
          key={step}
          aria-current={stepState === 'current' || stepState === 'running' ? 'step' : undefined}
          className="flex min-w-0 flex-1 flex-col items-center gap-1.5"
        >
          <span className="flex w-full items-center">
            <span
              aria-hidden
              className={`h-px flex-1 ${index === 0 ? 'bg-transparent' : 'bg-border'}`}
            />
            <span
              aria-hidden
              className={`flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${MARK[stepState]}`}
            >
              {stepState === 'done' || stepState === 'ended-well' ? (
                <Check size={13} strokeWidth={3} />
              ) : stepState === 'ended-badly' ? (
                <X size={13} strokeWidth={3} />
              ) : (
                index + 1
              )}
            </span>
            <span
              aria-hidden
              className={`h-px flex-1 ${index === 4 ? 'bg-transparent' : 'bg-border'}`}
            />
          </span>
          <span className={`text-xs ${WORD[stepState]}`}>
            {STEP_WORDS[step]}
            <span className="sr-only">, {SPOKEN[stepState]}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}
