/**
 * Checks for the fire-and-forget delegation path: `checkTask` and `collectTask`
 * against a fake machine, so no Rayrun API and no real workspace are involved.
 *
 *   node test/async-delegate.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { checkTask, collectTask } from '../lib/delegate.js'
import { WorkspaceLocks } from '../lib/workspace-lock.js'

const TASK = 'task-test1'
const MACHINE = { id: 'sb-1', name: 'box' }

/** A machine that answers the three commands the delegation path runs. */
function fakeRay({ running = false, files = ['decision.txt', 'questions.md'] } = {}) {
  const downloaded = []
  return {
    downloaded,
    async exec(_id, payload) {
      const command = String(payload?.command ?? '')
      if (command === 'pwd') return { stdout: '/workspace\n', exit_code: 0 }
      if (command.includes('ps -eo args')) {
        return {
          stdout: [
            `running=${running ? 1 : 0}`,
            'activity=2026-11-02 00:10:00.000000000 +0000',
            ...files.map((name) => `file=${name}`),
          ].join('\n'),
          exit_code: 0,
        }
      }
      if (command.includes('ls -1')) return { stdout: files.join('\n'), exit_code: 0 }
      return { stdout: '', exit_code: 0 }
    },
    async downloadFile(_id, remotePath) {
      downloaded.push(remotePath)
      const name = remotePath.split('/').pop()
      const body = name === 'questions.md' ? 'pick A or B\n' : 'done\n'
      return { arrayBuffer: async () => Buffer.from(body, 'utf8') }
    },
    async machine() {
      return { usage: { vm_hours: 1 } }
    },
  }
}

const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('status reports whether a worker is still on the task', async () => {
  const running = await checkTask({ ray: fakeRay({ running: true }), machine: MACHINE, taskId: TASK })
  assert.equal(running.running, true)
  assert.deepEqual(running.files, ['decision.txt', 'questions.md'])
  assert.match(running.activity, /^2026-11-02/)

  const idle = await checkTask({ ray: fakeRay(), machine: MACHINE, taskId: TASK })
  assert.equal(idle.running, false, 'no headless worker line means idle')
})

check('collect downloads the worker files and keeps the lock while it runs', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'delegate-test-'))
  try {
    const locks = new WorkspaceLocks()
    locks.acquire(MACHINE.id, { holder: `delegate ${TASK}`, reason: TASK })
    const ray = fakeRay({ running: true })
    const collected = await collectTask({ ray, machine: MACHINE, localDir: dir, taskId: TASK, locks })
    assert.equal(collected.running, true)
    assert.equal(collected.released, false, 'a running task keeps its push lock')
    assert.ok(locks.status(MACHINE.id), 'the lock is still held')
    assert.deepEqual(collected.results, ['decision.txt', 'questions.md'])
    assert.equal(collected.questions.trim(), 'pick A or B')
    assert.equal(await readFile(path.join(dir, '.dsh/results', TASK, 'decision.txt'), 'utf8'), 'done\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

check('collect releases the lock once the worker is gone', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'delegate-test-'))
  try {
    await mkdir(path.join(dir, '.dsh/results'), { recursive: true })
    const locks = new WorkspaceLocks()
    locks.acquire(MACHINE.id, { holder: `delegate ${TASK}`, reason: TASK })
    const collected = await collectTask({ ray: fakeRay(), machine: MACHINE, localDir: dir, taskId: TASK, locks })
    assert.equal(collected.released, true)
    assert.equal(locks.status(MACHINE.id), null, 'the lock is free again')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

check('an unusable task id is refused before any command runs', async () => {
  for (const bad of ['../escape', 'a/b', '', 'x'.repeat(81)]) {
    await assert.rejects(
      () => checkTask({ ray: fakeRay(), machine: MACHINE, taskId: bad }),
      (error) => error?.code === 'invalid_task_id',
      `expected refusal for ${JSON.stringify(bad)}`,
    )
  }
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
