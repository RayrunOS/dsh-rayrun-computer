/**
 * Unit checks for the cloud worker projection (lib/cloud-dsh.js).
 *
 * Pure: no Rayrun API, no network. Run with `node test/cloud-profile.mjs`.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LAYER_FILE,
  MANIFEST_FILE,
  exportProfileProjection,
  filesRevision,
  projectionLayer,
  readPluginFiles,
  revisionFromHashes,
  scanSecrets,
  sha256,
} from '../lib/cloud-dsh.js'

const packageDir = fileURLToPath(new URL('../', import.meta.url))

const checks = []
function check(name, fn) {
  checks.push({ name, fn })
}

check('layer is deterministic and restates both override configs', () => {
  const first = projectionLayer({ sourceProfile: 'desktop' })
  const second = projectionLayer({ sourceProfile: 'desktop' })
  assert.equal(first, second)
  assert.match(first, /mode: danger-full-access/)
  assert.match(first, /workspaceRoot: !!js process\.cwd\(\)/)
  assert.match(first, /policy: never/)
  assert.match(first, /id: sandbox-policy/)
  assert.match(first, /id: approval/)
})

check('layer revision tracks the source profile name', () => {
  const a = sha256(projectionLayer({ sourceProfile: 'desktop' }))
  const b = sha256(projectionLayer({ sourceProfile: 'rescue' }))
  // The source name appears in a comment, so the revision must change with it.
  assert.notEqual(a, b)
})

check('projection exposes a stable revision independent of the timestamp', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cloud-proj-'))
  await writeFile(path.join(dir, 'package.json'), '{"name":"dsh-profile-desktop"}\n')
  await writeFile(path.join(dir, 'cordis.patch.yml'), '- id: ui-chat\n')
  const first = await exportProfileProjection({ sourceProfile: 'desktop', sourceDir: dir, plugin: { name: 'p', version: '1' } })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const second = await exportProfileProjection({ sourceProfile: 'desktop', sourceDir: dir, plugin: { name: 'p', version: '1' } })
  assert.equal(first.rev, second.rev)
  assert.notEqual(first.manifest.generatedAt, second.manifest.generatedAt)
  assert.equal(first.rev, sha256(first.files[LAYER_FILE]))
  assert.equal(first.manifest.files[LAYER_FILE], first.rev)
})

check('manifest records provenance without secrets', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cloud-proj-'))
  await writeFile(path.join(dir, 'package.json'), '{"name":"dsh-profile-desktop"}\n')
  await writeFile(path.join(dir, 'cordis.patch.yml'), '[]\n')
  const { files, manifest } = await exportProfileProjection({
    sourceProfile: 'desktop',
    sourceDir: dir,
    plugin: { name: 'dsh-rayrun-computer', version: '9.9.9' },
  })
  assert.equal(manifest.kind, 'dsh-rayrun-cloud-projection')
  assert.equal(manifest.profile, 'headless')
  assert.equal(manifest.sourceProfile, 'desktop')
  assert.match(manifest.sourceRev, /^[0-9a-f]{64}$/)
  assert.deepEqual(Object.keys(files).sort(), [MANIFEST_FILE, LAYER_FILE].sort())
  assert.equal(manifest.capabilities.shell, 'danger-full-access')
  assert.equal(manifest.capabilities.cloudMode, true)
  assert.ok(!JSON.stringify(files).includes('.credentials.yaml'))
})

check('secret scan rejects credential shapes', () => {
  const cases = [
    ['sk-abcdefghijklmnopqrstuvwx', 'deepseek_key'],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz', 'bearer_token'],
    ['-----BEGIN OPENSSH PRIVATE KEY-----', 'private_key'],
    ['DEEPSEEK_API_KEY=abcdefghijklmnop', 'secret_assignment'],
    ['root: ~/.dsh/.credentials.yaml', 'credential_store'],
  ]
  for (const [text, rule] of cases) {
    assert.throws(
      () => scanSecrets({ 'cordis.patch.yml': text }),
      (error) => error.code === 'secret_detected' && error.message.includes(rule),
      `expected the ${rule} rule to reject ${JSON.stringify(text)}`,
    )
  }
  assert.doesNotThrow(() => scanSecrets({ 'cordis.patch.yml': projectionLayer({ sourceProfile: 'desktop' }) }))
})

check('a projected plugin gets its own cloudMode row', () => {
  const withPlugin = projectionLayer({ sourceProfile: 'desktop', plugin: { name: 'dsh-rayrun-computer' } })
  assert.match(withPlugin, /- id: rayrun-cloud\n {2}name: 'dsh-rayrun-computer'\n {2}config:\n {4}cloudMode: true/)
  assert.notEqual(
    sha256(withPlugin),
    sha256(projectionLayer({ sourceProfile: 'desktop' })),
    'shipping the plugin changes the layer revision',
  )
})

check('plugin revision is the same from contents and from remote hashes', async () => {
  const files = await readPluginFiles(packageDir)
  const hashes = Object.fromEntries(
    Object.entries(files).map(([name, content]) => [name, createHash('sha256').update(content).digest('hex')]),
  )
  assert.equal(filesRevision(files), revisionFromHashes(hashes))
  assert.match(filesRevision(files), /^[0-9a-f]{64}$/)
})

check('the projected plugin file set is what a headless worker needs', async () => {
  const files = await readPluginFiles(packageDir)
  const names = Object.keys(files).sort()
  for (const required of [
    'package.json',
    'index.js',
    'cordis.patch.yml',
    'lib/rayrun.js',
    'lib/cloud-dsh.js',
    'lib/cloud-workspace.js',
    'lib/workspace-lock.js',
  ]) {
    assert.ok(names.includes(required), `the projection is missing ${required}`)
  }
  const allowed = (name) => name === 'package.json' || name === 'index.js' || name === 'cordis.patch.yml' || name.startsWith('lib/')
  assert.ok(names.every(allowed), `unexpected projected files: ${names.filter((name) => !allowed(name)).join(', ')}`)
  assert.ok(!names.includes('client.js'), 'a headless profile serves no client bundle')
  assert.doesNotThrow(() => scanSecrets(files))
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
