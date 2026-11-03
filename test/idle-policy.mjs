/**
 * Checks for the idle-stop policy: which fact wins when a timer fires, and how
 * the machine probe that feeds it is read.
 *
 *   node test/idle-policy.mjs
 */
import assert from 'node:assert/strict'
import { hasRunningWorker } from '../lib/delegate.js'
import { decideIdleStop, describeIdle } from '../lib/idle-policy.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('idle stop is off unless it is configured', () => {
  assert.deepEqual(decideIdleStop({ minutes: 0, workerRunning: true }), { stop: false, reason: 'disabled' })
  assert.deepEqual(decideIdleStop({}), { stop: false, reason: 'disabled' })
})

check('a failed probe never stops a machine', () => {
  assert.deepEqual(decideIdleStop({ minutes: 15, reachable: false }), { stop: false, reason: 'unknown' })
})

check('a running worker outranks the lock and drift checks', () => {
  const decision = decideIdleStop({
    minutes: 15,
    workerRunning: true,
    lock: { holder: 'delegate task-1' },
    drifted: true,
  })
  assert.deepEqual(decision, { stop: false, reason: 'worker-running' })
})

check('a held lock outranks drift, and drift alone refuses the stop', () => {
  assert.deepEqual(decideIdleStop({ minutes: 15, lock: { holder: 'exec on box' }, drifted: true }), {
    stop: false,
    reason: 'busy',
  })
  assert.deepEqual(decideIdleStop({ minutes: 15, drifted: true }), { stop: false, reason: 'unpulled-changes' })
})

check('a quiet machine stops', () => {
  assert.deepEqual(decideIdleStop({ minutes: 15 }), { stop: true, reason: 'idle' })
})

check('the inspect line says what was decided and when', () => {
  assert.equal(describeIdle(undefined), 'not evaluated yet')
  const line = describeIdle({ at: Date.UTC(2026, 10, 3, 1, 2, 3), stop: false, reason: 'worker-running' })
  assert.match(line, /^worker-running at 2026-11-03T01:02:03\.000Z$/)
  assert.match(describeIdle({ at: Date.now(), stop: true, reason: 'idle' }), /\(stopped\)/)
})

check('the machine probe reads the headless worker count', async () => {
  const seen = []
  const ray = {
    async exec(_id, payload) {
      seen.push(String(payload?.command))
      return { stdout: '1\n', exit_code: 0 }
    },
  }
  assert.equal(await hasRunningWorker({ ray, machineId: 'sb-1' }), true)
  assert.match(seen[0], /\[d\]sh --profile headless/, 'the pattern cannot match its own grep')

  const idle = { async exec() { return { stdout: '0\n', exit_code: 0 } } }
  assert.equal(await hasRunningWorker({ ray: idle, machineId: 'sb-1' }), false)

  const empty = { async exec() { return { stdout: '', exit_code: 0 } } }
  assert.equal(await hasRunningWorker({ ray: empty, machineId: 'sb-1' }), false)
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
