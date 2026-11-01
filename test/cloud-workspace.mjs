/**
 * Checks for the workspace projection (lib/cloud-workspace.js).
 *
 * The parsing and path rules are pure; the local half runs against a throwaway
 * git repo, so no Rayrun API and no network are involved.
 *
 *   node test/cloud-workspace.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertSafeRelative, diffDigest, diffFileCount, parsePorcelain, readLocalWorkspace } from '../lib/cloud-workspace.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })

function git(cwd, args) {
  // No pipes: a confined host refuses piped stdio, and setup commands need no output.
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true, stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} exit ${code}`))))
  })
}

check('porcelain parsing separates tracked, untracked and renamed entries', () => {
  const parsed = parsePorcelain(Buffer.from(' M README.md\0?? new file.txt\0R  renamed.txt\0old.txt\0 A keep.md\0'))
  assert.deepEqual(parsed.untracked, ['new file.txt'])
  assert.deepEqual(parsed.dirty, ['README.md', 'renamed.txt', 'keep.md'])
  assert.equal(parsed.changes.length, 4)
})

check('unsafe paths are refused', () => {
  assert.equal(assertSafeRelative('docs/plan.md'), 'docs/plan.md')
  assert.equal(assertSafeRelative('a\\b.txt'), 'a/b.txt')
  for (const bad of ['/etc/passwd', '../up.txt', 'a/../../b', '.git/config', 'a;b', 'a$(id).txt', "it's.txt", '', 'a\nb']) {
    assert.throws(() => assertSafeRelative(bad), (error) => error.code === 'unsafe_path', `expected refusal for ${JSON.stringify(bad)}`)
  }
})

check('digests and diff stats are stable', () => {
  const patch = Buffer.from('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y b/y\n')
  assert.equal(diffDigest(patch), diffDigest(patch))
  assert.notEqual(diffDigest(patch), diffDigest(''))
  assert.equal(diffFileCount(patch.toString('utf8')), 2)
})

check('a dirty checkout round-trips through readLocalWorkspace', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workspace-test-'))
  try {
    await git(dir, ['init', '-q'])
    await git(dir, ['config', 'user.email', 'test@example.com'])
    await git(dir, ['config', 'user.name', 'Test'])
    await writeFile(path.join(dir, 'tracked.txt'), 'one\n')
    await git(dir, ['add', 'tracked.txt'])
    await git(dir, ['commit', '-q', '-m', 'initial'])
    await writeFile(path.join(dir, 'tracked.txt'), 'one\ntwo\n')
    await mkdir(path.join(dir, 'nested'), { recursive: true })
    await writeFile(path.join(dir, 'nested', 'new.txt'), 'hello\n')
    const state = await readLocalWorkspace(dir)
    assert.match(state.head, /^[0-9a-f]{40}$/)
    assert.deepEqual(state.untracked.map((file) => file.path), ['nested/new.txt'])
    assert.equal(state.untracked[0].content.toString('utf8'), 'hello\n')
    assert.deepEqual(state.changes.dirty, ['tracked.txt'])
    assert.deepEqual(state.changes.untracked, ['nested/new.txt'])
    assert.match(state.digest, /^[0-9a-f]{64}$/)
    assert.match(state.untrackedDigest, /^[0-9a-f]{64}$/)
    assert.ok(state.patch.toString('utf8').includes('+two'))
    assert.ok(!state.patch.toString('utf8').includes('nested/new.txt'), 'untracked files travel outside the patch')
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})

check('untracked content changes the untracked revision', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workspace-test-'))
  try {
    await git(dir, ['init', '-q'])
    await git(dir, ['config', 'user.email', 'test@example.com'])
    await git(dir, ['config', 'user.name', 'Test'])
    await writeFile(path.join(dir, 'tracked.txt'), 'one\n')
    await git(dir, ['add', 'tracked.txt'])
    await git(dir, ['commit', '-q', '-m', 'initial'])
    await writeFile(path.join(dir, 'loose.txt'), 'a\n')
    const first = await readLocalWorkspace(dir)
    await writeFile(path.join(dir, 'loose.txt'), 'b\n')
    const second = await readLocalWorkspace(dir)
    assert.notEqual(first.untrackedDigest, second.untrackedDigest)
    assert.equal(first.digest, second.digest, 'the dirty patch is unaffected by untracked content')
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
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
