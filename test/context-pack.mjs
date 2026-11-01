/**
 * Checks for the Context Pack (lib/context-pack.js).
 *
 *   node test/context-pack.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  HANDOFF_DIR,
  RESULTS_DIR,
  buildContextPack,
  delegationPrompt,
  profileRevision,
  readTaskState,
  revsEchoed,
  roundPath,
  validateBrief,
  workspaceRevision,
  writeContextPack,
} from '../lib/context-pack.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })

const revs = { sessionSeq: 42, workspaceRev: 'w'.repeat(64), profileRev: 'p'.repeat(64) }
const workspace = { head: 'a'.repeat(40), dirtyDigest: 'd'.repeat(64), dirtyFiles: 3, untracked: ['a.md'] }
const profile = { name: 'desktop', layerRev: 'l'.repeat(64), pluginRev: 'q'.repeat(64), pluginVersion: '2.0.0' }
const brief = { objective: '改成流式', acceptance: ['测试通过', '不新增加依赖'], constraints: ['不改 UI'] }

check('required brief fields are enforced', () => {
  assert.deepEqual(validateBrief({}).missing, ['objective', 'acceptance'])
  assert.deepEqual(validateBrief({ objective: 'x' }).missing, ['acceptance'])
  assert.deepEqual(validateBrief({ objective: 'x', acceptance: [] }).missing, ['acceptance'])
  assert.equal(validateBrief(brief).ok, true)
})

check('revisions are stable and state-specific', () => {
  assert.equal(workspaceRevision(workspace), workspaceRevision({ ...workspace }))
  assert.notEqual(workspaceRevision(workspace), workspaceRevision({ ...workspace, dirtyDigest: 'e'.repeat(64) }))
  assert.notEqual(
    workspaceRevision({ ...workspace, untrackedDigest: 'u'.repeat(64) }),
    workspaceRevision({ ...workspace, untrackedDigest: 'v'.repeat(64) }),
    'untracked content belongs to the workspace rev',
  )
  assert.notEqual(profileRevision(profile), profileRevision({ ...profile, pluginRev: 'r'.repeat(64) }))
  assert.match(workspaceRevision(workspace), /^[0-9a-f]{64}$/)
})

check('a pack carries every file the worker is told to read', () => {
  const pack = buildContextPack({
    taskId: 'task-1',
    brief,
    revs,
    workspace,
    profile,
    patch: Buffer.from('diff --git a/x b/x\n'),
    notes: '上次讨论过用 SSE。',
    createdAt: '2026-11-01T00:00:00.000Z',
  })
  const names = Object.keys(pack.files).sort()
  assert.deepEqual(names, ['conversation.md', 'handoff.md', 'manifest.json', 'profile.json', 'workspace.patch'])
  assert.match(pack.files['handoff.md'], /改成流式/)
  assert.match(pack.files['handoff.md'], /测试通过/)
  assert.match(pack.files['handoff.md'], /sessionSeq: 42/)
  assert.match(pack.files['handoff.md'], new RegExp(revs.workspaceRev))
  assert.match(pack.files['conversation.md'], /上次讨论过用 SSE/)
  const manifest = JSON.parse(pack.files['manifest.json'])
  assert.equal(manifest.taskId, 'task-1')
  assert.deepEqual(manifest.revs, revs)
  assert.equal(manifest.workspace.head, workspace.head)
  assert.equal(manifest.profile.name, 'desktop')
  assert.deepEqual(manifest.brief.acceptance, ['测试通过', '不新增加依赖'])
  assert.deepEqual(Object.keys(manifest.files).sort(), ['conversation.md', 'handoff.md', 'profile.json', 'workspace.patch'])
  for (const digest of Object.values(manifest.files)) assert.match(digest, /^[0-9a-f]{64}$/)
})

check('an incomplete brief is refused before anything is written', () => {
  assert.throws(
    () => buildContextPack({ taskId: 't', brief: { objective: 'x' }, revs, workspace, profile, patch: Buffer.alloc(0) }),
    (error) => error.code === 'brief_incomplete' && error.missing.includes('acceptance'),
  )
})

check('the delegation prompt names the round directory and the expected revs', () => {
  const prompt = delegationPrompt({ taskId: 'task-9', round: 3, revs })
  assert.match(prompt, /\.dsh\/handoff\/task-9\/round-3\/handoff\.md/)
  assert.match(prompt, /REVS sessionSeq=42/)
  assert.match(prompt, new RegExp(`workspaceRev=${revs.workspaceRev}`))
  assert.match(prompt, /\.dsh\/results\/task-9\/questions\.md/)
})

check('rev echo detection needs all three values', () => {
  const good = `REVS sessionSeq=42 workspaceRev=${revs.workspaceRev} profileRev=${revs.profileRev}`
  assert.equal(revsEchoed(good, revs), true)
  assert.equal(revsEchoed(good.replace('42', '41'), revs), false)
  assert.equal(revsEchoed('REVS sessionSeq=42', revs), false)
  assert.equal(revsEchoed('', revs), false)
})

check('each round is written under its own directory and recorded in task.json', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pack-test-'))
  try {
    const first = buildContextPack({ taskId: 'task-2', round: 1, brief, revs, workspace, profile, patch: Buffer.from('x\n') })
    const written = await writeContextPack({ localDir: dir, taskId: 'task-2', round: 1, pack: first })
    assert.equal(written.dir, path.join(dir, HANDOFF_DIR, 'task-2', 'round-1'))
    assert.equal(written.task.rounds, 1)
    const manifest = JSON.parse(await readFile(path.join(written.dir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.revs.sessionSeq, 42)
    assert.equal(manifest.round, 1)
    assert.match(await readFile(path.join(written.dir, 'handoff.md'), 'utf8'), /验收标准/)
    assert.equal(RESULTS_DIR, '.dsh/results')

    const second = buildContextPack({
      taskId: 'task-2',
      round: 2,
      brief,
      revs,
      workspace,
      profile,
      patch: Buffer.alloc(0),
      questions: '要不要保留旧接口？',
    })
    const secondWritten = await writeContextPack({ localDir: dir, taskId: 'task-2', round: 2, pack: second })
    assert.equal(secondWritten.dir, path.join(dir, HANDOFF_DIR, 'task-2', 'round-2'))
    assert.equal(secondWritten.task.rounds, 2)
    assert.match(await readFile(path.join(secondWritten.dir, 'handoff.md'), 'utf8'), /要不要保留旧接口/)
    const state = await readTaskState({ localDir: dir, taskId: 'task-2' })
    assert.equal(state.rounds, 2)
    assert.equal(state.lastRound, 2)
    assert.equal(await readTaskState({ localDir: dir, taskId: 'never-seen' }), null)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})

check('a pack refuses authored text that carries a credential', () => {
  assert.throws(
    () =>
      buildContextPack({
        taskId: 't',
        brief: { objective: '用这个 key: sk-abcdefghijklmnopqrstuvwx', acceptance: ['ok'] },
        revs,
        workspace,
        profile,
        patch: Buffer.alloc(0),
      }),
    (error) => error.code === 'secret_detected',
  )
  assert.doesNotThrow(() =>
    buildContextPack({ taskId: 't', brief, revs, workspace, profile, patch: Buffer.from('sk-abcdefghijklmnopqrstuvwx\n') }),
  )
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
