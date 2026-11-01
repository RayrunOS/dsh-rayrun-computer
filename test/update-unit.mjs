import assert from 'node:assert/strict'
import { applyUpdate, canAutoUpdate, fetchLatestVersion, isNewer, parseVersion } from '../lib/update.js'

const NAME = 'dsh-rayrun-computer'
let passed = 0

async function check(label, fn) {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${label}`)
}

await check('parseVersion accepts stable versions only', () => {
  assert.deepEqual(parseVersion('2.1.0'), [2, 1, 0])
  assert.deepEqual(parseVersion(' 10.0.3 '), [10, 0, 3])
  assert.equal(parseVersion('2.1'), null)
  assert.equal(parseVersion('2.1.0-beta.1'), null)
  assert.equal(parseVersion(undefined), null)
})

await check('isNewer compares releases numerically', () => {
  assert.equal(isNewer('2.1.0', '2.0.0'), true)
  assert.equal(isNewer('2.0.10', '2.0.9'), true)
  assert.equal(isNewer('10.0.0', '9.9.9'), true)
  assert.equal(isNewer('2.0.0', '2.0.0'), false)
  assert.equal(isNewer('2.0.0', '2.1.0'), false)
  assert.equal(isNewer('2.1.0-beta.1', '2.0.0'), false)
  assert.equal(isNewer(null, '2.0.0'), false)
})

await check('canAutoUpdate accepts registry specs only', () => {
  assert.equal(canAutoUpdate(`${NAME}@^2.0.0`, NAME), true)
  assert.equal(canAutoUpdate(`${NAME}@2.0.0`, NAME), true)
  assert.equal(canAutoUpdate('link:D:/Rayrun-dp-harness', NAME), false)
  assert.equal(canAutoUpdate('file:../repo', NAME), false)
  assert.equal(canAutoUpdate('git+https://github.com/RayrunOS/dsh-rayrun-computer.git#abc', NAME), false)
  assert.equal(canAutoUpdate(undefined, NAME), false)
})

const registry = (answers) => async (url) => {
  const entry = answers.find(([host]) => url.startsWith(host))
  if (!entry) throw new Error(`unexpected url ${url}`)
  const [, response] = entry
  if (response instanceof Error) throw response
  return response
}

const json = (body) => ({ ok: true, status: 200, json: async () => body })

await check('fetchLatestVersion falls back to the mirror', async () => {
  const urls = []
  const answer = async (url) => {
    urls.push(url)
    if (url.startsWith('https://registry.npmjs.org')) return { ok: false, status: 503 }
    return json({ version: '2.3.4' })
  }
  const version = await fetchLatestVersion(NAME, { fetch: answer })
  assert.equal(version, '2.3.4')
  assert.equal(urls.length, 2)
  assert.ok(urls[0].endsWith(`/${NAME}/latest`))
})

await check('fetchLatestVersion reports a registry that answers without a version', async () => {
  await assert.rejects(
    fetchLatestVersion(NAME, {
      fetch: registry([['https://registry.npmjs.org', json({ version: 'nightly' })]]),
      registries: ['https://registry.npmjs.org'],
    }),
    /no usable version/,
  )
})

await check('applyUpdate removes, then installs the new version', async () => {
  const calls = []
  const manager = {
    removeBundle: async (name) => calls.push(['remove', name]),
    installBundle: async (spec, options) => {
      calls.push(['install', spec, options])
      return { application: 'restart-required', version: '2.1.0', restartReason: 'no-hmr' }
    },
  }
  const result = await applyUpdate(manager, { name: NAME, from: '2.0.0', to: '2.1.0' })
  assert.equal(result.ok, true)
  assert.equal(result.application, 'restart-required')
  assert.equal(result.version, '2.1.0')
  assert.deepEqual(calls, [
    ['remove', NAME],
    ['install', `${NAME}@2.1.0`, { enabled: true, saveExact: true }],
  ])
})

await check('applyUpdate restores the old version when the install fails', async () => {
  const calls = []
  const manager = {
    removeBundle: async () => calls.push('remove'),
    installBundle: async (spec) => {
      calls.push(spec)
      if (spec === `${NAME}@2.1.0`) {
        return { application: 'failed', error: { code: 'incompatible-version', message: 'needs a newer DSH' } }
      }
      return { application: 'applied', version: '2.0.0' }
    },
  }
  const result = await applyUpdate(manager, { name: NAME, from: '2.0.0', to: '2.1.0' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'install_failed')
  assert.equal(result.rolledBack, true)
  assert.deepEqual(calls, ['remove', `${NAME}@2.1.0`, `${NAME}@2.0.0`])
})

await check('applyUpdate treats a rejected install as failed and still restores', async () => {
  const calls = []
  const manager = {
    removeBundle: async () => calls.push('remove'),
    installBundle: async (spec) => {
      calls.push(spec)
      if (spec === `${NAME}@2.1.0`) throw new Error('pnpm lock is busy')
      return { application: 'applied', version: '2.0.0' }
    },
  }
  const result = await applyUpdate(manager, { name: NAME, from: '2.0.0', to: '2.1.0' })
  assert.equal(result.code, 'install_failed')
  assert.equal(result.rolledBack, true)
  assert.deepEqual(calls, ['remove', `${NAME}@2.1.0`, `${NAME}@2.0.0`])
})

await check('applyUpdate never installs when the removal is refused', async () => {
  const calls = []
  const manager = {
    removeBundle: async () => {
      throw new Error('stop-profile')
    },
    installBundle: async (spec) => calls.push(spec),
  }
  const result = await applyUpdate(manager, { name: NAME, from: '2.0.0', to: '2.1.0' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'remove_failed')
  assert.equal(result.rolledBack, false)
  assert.deepEqual(calls, [])
})

console.log(`\n${passed} update checks passed`)
