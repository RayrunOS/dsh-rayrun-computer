/**
 * Checks for the workspace lock and the push conflict rules
 * (lib/workspace-lock.js). Pure: no Rayrun API and no git.
 *
 *   node test/workspace-lock.mjs
 */
import assert from 'node:assert/strict'
import { EMPTY_DIGEST, WorkspaceLocks, decidePush, pushedState } from '../lib/workspace-lock.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })

const HEAD_A = 'a'.repeat(40)
const HEAD_B = 'b'.repeat(40)
const DIGEST_1 = '1'.repeat(64)
const DIGEST_2 = '2'.repeat(64)

check('a second holder is refused while the lock is live', () => {
  const locks = new WorkspaceLocks({ now: () => 1000 })
  locks.acquire('m1', { holder: 'agent task' })
  assert.throws(
    () => locks.acquire('m1', { holder: 'exec' }),
    (error) => error.code === 'workspace_locked' && /agent task/.test(error.message),
  )
})

check('the same holder refreshes instead of failing, and release clears it', () => {
  let clock = 1000
  const locks = new WorkspaceLocks({ now: () => clock })
  const first = locks.acquire('m1', { holder: 'exec', ttlMs: 5000 })
  clock = 3000
  const again = locks.acquire('m1', { holder: 'exec', ttlMs: 5000 })
  assert.equal(again.since, first.since, 'refresh keeps the original start time')
  assert.equal(again.expiresAt, 8000)
  assert.equal(locks.release('m1', 'exec'), true)
  assert.equal(locks.status('m1'), null)
})

check('an expired lock no longer blocks anyone', () => {
  let clock = 1000
  const locks = new WorkspaceLocks({ now: () => clock })
  locks.acquire('m1', { holder: 'exec', ttlMs: 1000 })
  clock = 2500
  assert.equal(locks.status('m1'), null)
  assert.doesNotThrow(() => locks.acquire('m1', { holder: 'push' }))
})

check('a release from another holder does not free the lock', () => {
  const locks = new WorkspaceLocks({ now: () => 1000 })
  locks.acquire('m1', { holder: 'agent' })
  assert.equal(locks.release('m1', 'exec'), false)
  assert.ok(locks.status('m1'))
})

check('push decision matrix', () => {
  const local = { head: HEAD_A, digest: DIGEST_1 }
  const cases = [
    { name: 'fresh workspace', input: { local, cloud: { head: null, digest: EMPTY_DIGEST } }, ok: true, reason: 'empty-workspace' },
    { name: 'already mirrored', input: { local, cloud: local }, ok: true, reason: 'already-mirrored' },
    { name: 'busy workspace', input: { local, cloud: local, lock: { holder: 'agent task', reason: 'refactor' } }, ok: false, code: 'workspace_locked' },
    { name: 'force wins over a lock', input: { local, cloud: local, lock: { holder: 'agent task' }, force: true }, ok: true, reason: 'forced' },
    {
      name: 'cloud matches our last push',
      input: { local, cloud: { head: HEAD_B, digest: DIGEST_2 }, state: pushedState({ head: HEAD_B, digest: DIGEST_2 }) },
      ok: true,
      reason: 'clean',
    },
    {
      name: 'cloud dirty since our push',
      input: { local, cloud: { head: HEAD_A, digest: DIGEST_2 }, state: pushedState({ head: HEAD_A, digest: DIGEST_1 }) },
      ok: false,
      code: 'workspace_drift',
    },
    {
      name: 'cloud head moved since our push',
      input: { local, cloud: { head: HEAD_B, digest: DIGEST_1 }, state: pushedState({ head: HEAD_A, digest: DIGEST_1 }) },
      ok: false,
      code: 'workspace_drift',
    },
    {
      name: 'unknown prior tree (no bookkeeping)',
      input: { local, cloud: { head: HEAD_B, digest: DIGEST_2 }, state: null },
      ok: false,
      code: 'workspace_drift',
    },
    {
      name: 'clean last push',
      input: { local: { head: HEAD_A, digest: DIGEST_2 }, cloud: { head: HEAD_A, digest: DIGEST_1 }, state: pushedState({ head: HEAD_A, digest: DIGEST_1 }) },
      ok: true,
      reason: 'clean',
    },
  ]
  for (const item of cases) {
    const result = decidePush(item.input)
    assert.equal(result.ok, item.ok, `${item.name}: ${JSON.stringify(result)}`)
    if (item.ok) assert.equal(result.reason, item.reason, item.name)
    else assert.equal(result.code, item.code, item.name)
  }
})

check('pushed state is stable and self-describing', () => {
  const state = pushedState({ head: HEAD_A, digest: DIGEST_1, pushedAt: '2026-11-01T00:00:00.000Z' })
  assert.deepEqual(state, { version: 1, head: HEAD_A, digest: DIGEST_1, pushedAt: '2026-11-01T00:00:00.000Z' })
  const withUntracked = pushedState({ head: HEAD_A, digest: DIGEST_1, untrackedDigest: 'u'.repeat(64) })
  assert.equal(withUntracked.untrackedDigest, 'u'.repeat(64))
  assert.equal(decidePush({ local: { head: HEAD_A, digest: DIGEST_1, untrackedDigest: 'v'.repeat(64) }, cloud: { head: HEAD_A, digest: DIGEST_1 }, state: withUntracked }).reason, 'clean')
  assert.equal(decidePush({ local: { head: HEAD_A, digest: DIGEST_1, untrackedDigest: 'u'.repeat(64) }, cloud: { head: HEAD_A, digest: DIGEST_1 }, state: withUntracked }).reason, 'already-mirrored')
})

let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}`)
    console.log(`     ${error?.message ?? error}`)
  }
}
console.log(`${checks.length - failed}/${checks.length} checks passed`)
if (failed) process.exitCode = 1
