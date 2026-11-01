/**
 * Drives the real `/plugins/rayrun` handler from index.js with a fake Harness
 * context and a fake plugin manager, so the update route is exercised without
 * booting a profile.
 *
 *   node test/update-rpc.mjs          # an update is available
 *   node test/update-rpc.mjs missing  # the registry has no published version
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { apply } from '../index.js'

const NAME = 'dsh-rayrun-computer'
const scenario = process.argv[2] ?? 'available'
const realFetch = globalThis.fetch

globalThis.fetch = async (url) => {
  if (!String(url).includes(NAME)) return realFetch(url)
  if (scenario === 'missing') return { ok: false, status: 404, json: async () => ({}) }
  return { ok: true, status: 200, json: async () => ({ version: '9.9.9' }) }
}

function credentials() {
  return { resolve: async () => undefined, set: async () => {}, unset: async () => {} }
}

function hostFor(manager) {
  const routes = []
  const store = credentials()
  const child = {
    effect(fn) {
      fn()
      return () => {}
    },
    get(name) {
      if (name === 'pluginManager') return manager
      if (name === 'credentials') return store
      return undefined
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
      getOrigin: () => 'http://127.0.0.1:1',
    },
  }
  const ctx = {
    effect(fn) {
      fn()
      return () => {}
    },
    inject(deps, callback) {
      if (Array.isArray(deps) && deps.includes('webServer')) callback(child)
      return () => {}
    },
    get(name) {
      if (name === 'pluginManager') return manager
      if (name === 'credentials') return store
      return undefined
    },
    tools: { register() {} },
  }
  apply(ctx, {})
  assert.equal(routes.length, 1, 'the RPC route is registered once')
  return routes[0].handler
}

async function request(handler, { method = 'POST', action, body } = {}) {
  const payload = body ?? (action === undefined ? {} : { action })
  const req = Readable.from(method === 'GET' ? [] : [Buffer.from(JSON.stringify(payload))])
  req.method = method
  req.url = method === 'GET' ? `/plugins/rayrun?action=${encodeURIComponent(action)}` : '/plugins/rayrun'
  req.headers = {}
  const res = { writeHead() {}, end(text) { this.body = text } }
  await handler(req, res)
  return JSON.parse(res.body)
}

function manager({ source = `${NAME}@^2.0.0`, removeFails = false, installFailsFor } = {}) {
  const calls = []
  return {
    calls,
    async listBundles() {
      return [{ name: NAME, source, version: '2.0.0', installed: true, enabled: true, removable: true }]
    },
    async removeBundle(name) {
      calls.push(['remove', name])
      if (removeFails) throw new Error('stop-profile: this profile does not run HMR')
    },
    async installBundle(spec, options) {
      calls.push(['install', spec, options])
      if (installFailsFor !== undefined && spec === `${NAME}@${installFailsFor}`) {
        return { application: 'failed', error: { code: 'incompatible-version', message: 'needs a newer DSH' } }
      }
      return { application: 'restart-required', version: spec.slice(NAME.length + 1), restartReason: 'no-hmr' }
    },
  }
}

let passed = 0
async function check(label, fn) {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${label}`)
}

if (scenario === 'missing') {
  await check('a registry without the package reports no update', async () => {
    const handler = hostFor(manager())
    const reply = await request(handler, { action: 'update.check' })
    assert.equal(reply.ok, true)
    assert.equal(reply.update.available, false)
    assert.equal(reply.update.latest, null)
    assert.match(reply.update.error, /404/)
  })

  await check('applying without a published version is refused', async () => {
    const handler = hostFor(manager())
    const reply = await request(handler, { action: 'update.apply' })
    assert.equal(reply.ok, false)
    assert.equal(reply.error.code, 'up_to_date')
  })
} else {
  await check('update.check reports the published version', async () => {
    const handler = hostFor(manager())
    const reply = await request(handler, { action: 'update.check' })
    assert.equal(reply.ok, true)
    assert.equal(reply.update.current, '2.0.0')
    assert.equal(reply.update.latest, '9.9.9')
    assert.equal(reply.update.available, true)
    assert.equal(reply.update.canApply, true)
    assert.equal(reply.update.source, `${NAME}@^2.0.0`)
    assert.equal(reply.update.error, '')
  })

  await check('GET action=update reads the cached answer', async () => {
    const handler = hostFor(manager())
    const reply = await request(handler, { method: 'GET', action: 'update' })
    assert.equal(reply.ok, true)
    assert.equal(reply.update.latest, '9.9.9')
    assert.equal(reply.update.available, true)
  })

  await check('update.apply removes then installs the new version', async () => {
    const fake = manager()
    const handler = hostFor(fake)
    const reply = await request(handler, { action: 'update.apply' })
    assert.equal(reply.ok, true)
    assert.equal(reply.result.ok, true)
    assert.equal(reply.result.application, 'restart-required')
    assert.equal(reply.result.version, '9.9.9')
    assert.deepEqual(fake.calls, [
      ['remove', NAME],
      ['install', `${NAME}@9.9.9`, { enabled: true, saveExact: true }],
    ])
    assert.equal(reply.update.available, false)
  })

  await check('a linked checkout is never updated from the registry', async () => {
    const fake = manager({ source: 'link:D:/Rayrun-dp-harness' })
    const handler = hostFor(fake)
    const reply = await request(handler, { action: 'update.apply' })
    assert.equal(reply.ok, false)
    assert.equal(reply.error.code, 'update_locked')
    assert.deepEqual(fake.calls, [])
  })

  await check('a refused removal is reported without installing', async () => {
    const fake = manager({ removeFails: true })
    const handler = hostFor(fake)
    const reply = await request(handler, { action: 'update.apply' })
    assert.equal(reply.ok, true)
    assert.equal(reply.result.ok, false)
    assert.equal(reply.result.code, 'remove_failed')
    assert.deepEqual(fake.calls, [['remove', NAME]])
  })

  await check('a failed install restores the previous version', async () => {
    const fake = manager({ installFailsFor: '9.9.9' })
    const handler = hostFor(fake)
    const reply = await request(handler, { action: 'update.apply' })
    assert.equal(reply.result.ok, false)
    assert.equal(reply.result.code, 'install_failed')
    assert.equal(reply.result.rolledBack, true)
    assert.deepEqual(fake.calls, [
      ['remove', NAME],
      ['install', `${NAME}@9.9.9`, { enabled: true, saveExact: true }],
      ['install', `${NAME}@2.0.0`, { enabled: true, saveExact: true }],
    ])
  })

  await check('a profile without the plugin manager cannot apply', async () => {
    const handler = hostFor(undefined)
    const read = await request(handler, { method: 'GET', action: 'update' })
    assert.equal(read.ok, true)
    assert.equal(read.update.canApply, false)
    const reply = await request(handler, { action: 'update.apply' })
    assert.equal(reply.ok, false)
    assert.equal(reply.error.code, 'update_unavailable')
  })
}

globalThis.fetch = realFetch
console.log(`\n${passed} RPC checks passed (${scenario})`)
