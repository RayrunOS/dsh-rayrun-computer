/**
 * Why an idle machine may or may not be stopped.
 *
 * Stopping a machine that still has work on it loses the run, not just time: a
 * delegated worker keeps working inside the guest, and the workspace may hold
 * changes the user has never pulled. The decision is pure so the order of the
 * checks — and therefore what wins when two reasons apply — is testable
 * without a machine.
 *
 * Order matters:
 *  1. no configured idle time means nothing to decide;
 *  2. a failed probe is never evidence of an idle machine;
 *  3. a running worker outranks everything else: it is doing work right now;
 *  4. a held lock means a local task owns the workspace;
 *  5. unpulled changes would become invisible if the machine stopped.
 */

/** Every reason {@link decideIdleStop} can return, including the stop itself. */
export const IDLE_REASONS = ['idle', 'disabled', 'unknown', 'worker-running', 'busy', 'unpulled-changes']

/**
 * @param input - the facts gathered at timer time.
 * @param input.minutes - configured idle minutes; 0/undefined disables the feature.
 * @param input.workerRunning - whether a headless DSH worker is in the guest.
 * @param input.lock - the workspace lock entry held for this machine, if any.
 * @param input.drifted - whether the cloud tree moved since the last push.
 * @param input.reachable - whether every probe answered.
 * @returns `{ stop, reason }`; `reason` says why when `stop` is false.
 */
export function decideIdleStop({ minutes, workerRunning = false, lock = null, drifted = false, reachable = true } = {}) {
  if (!minutes) return { stop: false, reason: 'disabled' }
  if (!reachable) return { stop: false, reason: 'unknown' }
  if (workerRunning) return { stop: false, reason: 'worker-running' }
  if (lock) return { stop: false, reason: 'busy' }
  if (drifted) return { stop: false, reason: 'unpulled-changes' }
  return { stop: true, reason: 'idle' }
}

/** One line for `rayrun_sandbox inspect`: what the last timer decided, and when. */
export function describeIdle(decision) {
  if (!decision) return 'not evaluated yet'
  const at = Number.isFinite(Number(decision.at)) ? new Date(Number(decision.at)).toISOString() : 'unknown time'
  return `${decision.reason}${decision.stop ? ' (stopped)' : ''} at ${at}`
}
