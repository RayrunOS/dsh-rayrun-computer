/**
 * Workspace single-writer lock and push conflict decisions.
 *
 * The cloud workspace is mirrored, not merged: `push` replaces the cloud tree
 * with the local one. That is safe only when nobody else is writing there. Two
 * things can be true instead:
 *
 *  - a cloud task is running on this machine (a delegated agent, or `exec` work
 *    the user started), so a push would delete files under it;
 *  - the cloud tree moved since the last push (an agent edited files, or a pull
 *    was never applied locally), so a push would discard work.
 *
 * The lock is process-local: a Host restart forgets it, exactly like the
 * per-session task target. `force` stays available for the person who knows the
 * cloud side can be thrown away.
 */
import { LocalError } from './rayrun.js'

export class WorkspaceLocks {
  constructor({ now = () => Date.now(), defaultTtlMs = 30 * 60 * 1000 } = {}) {
    this.now = now
    this.defaultTtlMs = defaultTtlMs
    this.held = new Map()
  }

  live(entry) {
    return Boolean(entry) && entry.expiresAt > this.now()
  }

  /** Take or refresh the lock for a machine; a different holder is refused. */
  acquire(key, { holder, reason = '', ttlMs = this.defaultTtlMs } = {}) {
    const current = this.held.get(key)
    if (this.live(current) && current.holder !== holder) {
      throw new LocalError(
        'workspace_locked',
        `Cloud workspace ${key} is busy with "${current.holder}"${current.reason ? ` (${current.reason})` : ''} since ${new Date(current.since).toISOString()}. Wait for it, or push with force to discard its files.`,
      )
    }
    const entry = { key, holder, reason, since: current?.since && this.live(current) ? current.since : this.now(), expiresAt: this.now() + ttlMs }
    this.held.set(key, entry)
    return entry
  }

  release(key, holder) {
    const current = this.held.get(key)
    if (!current) return false
    if (holder && current.holder !== holder) return false
    this.held.delete(key)
    return true
  }

  status(key) {
    const current = this.held.get(key)
    return this.live(current) ? current : null
  }
}

export const EMPTY_DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/**
 * Decide whether a push may replace the cloud tree.
 *
 * `cloud` is what the machine reports now, `state` is what the last push wrote
 * there (absent on a machine this plugin has not pushed to), and `local` is the
 * checkout being sent. Pure: the caller does the I/O.
 */
export function decidePush({ local, cloud, state, lock, force = false } = {}) {
  // `force` is the documented escape hatch for both cases below: a hung task or
  // a cloud tree the operator knows can be thrown away.
  if (force) return { ok: true, reason: 'forced' }
  if (lock) {
    return {
      ok: false,
      code: 'workspace_locked',
      message: `Cloud workspace is busy with "${lock.holder}"${lock.reason ? ` (${lock.reason})` : ''}; wait for it to finish, or push with force.`,
    }
  }
  if (!cloud?.head) return { ok: true, reason: 'empty-workspace' }
  if (cloud.head === local?.head && cloud.digest === local?.digest) {
    // Untracked files travel outside the diff; when the last push recorded their
    // digest, a difference means a real update rather than a no-op.
    if (!state?.untrackedDigest || state.untrackedDigest === local?.untrackedDigest) {
      return { ok: true, reason: 'already-mirrored' }
    }
    return { ok: true, reason: 'clean' }
  }
  const expected = state ?? null
  if (!expected) {
    return {
      ok: false,
      code: 'workspace_drift',
      message:
        'The cloud workspace already holds a tree this plugin did not push last time; pushing would replace it. Pull it first, or push with force to discard it.',
    }
  }
  if (expected.head !== cloud.head) {
    return {
      ok: false,
      code: 'workspace_drift',
      message: `The cloud workspace moved to ${String(cloud.head).slice(0, 12)} after the last push (${String(expected.head).slice(0, 12)}); pull its changes, or push with force to discard them.`,
    }
  }
  if (expected.digest !== cloud.digest) {
    return {
      ok: false,
      code: 'workspace_drift',
      message: 'The cloud workspace has changes since the last push; pull them, or push with force to discard them.',
    }
  }
  return { ok: true, reason: 'clean' }
}

/** The bookkeeping a push leaves on the machine, so the next one can compare. */
export function pushedState({ head, digest, untrackedDigest, pushedAt = new Date().toISOString() }) {
  return { version: 1, head, digest, ...(untrackedDigest ? { untrackedDigest } : {}), pushedAt }
}
