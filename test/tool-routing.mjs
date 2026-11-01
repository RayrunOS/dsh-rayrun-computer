/**
 * Checks that the composer toggle is a real tool route: in 云上电脑 mode the
 * local write/execute tools are refused per session, while reads and the
 * rayrun_* tools stay usable.
 *
 *   node test/tool-routing.mjs
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const NAME = 'dsh-rayrun-computer'
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (String(url).includes(NAME)) return { ok: false, status: 404, json: async () => ({}) }
  return realFetch(url, init)
}

const store = { resolve: async () => undefined, set: async () => {}, unset: async () => {} }
const guards = []
const routes = []

const child = {
  effect(fn) {
    fn()
    return () => {}
  },
  get: (name) => (name === 'credentials' ? store : undefined),
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
    if (Array.isArray(deps) && deps.includes('systemPrompt')) {
      callback({ effect: (fn) => fn(), systemPrompt: { context: () => ({}) } })
    }
    return () => {}
  },
  get(name) {
    if (name === 'credentials') return store
    if (name === 'profileContext') return { name: 'desktop', dir: null }
    return undefined
  },
  tools: {
    register() {},
    guard(fn) {
      guards.push(fn)
      return () => {}
    },
  },
}

apply(ctx, {
  token_file: path.join(tmpdir(), `rayrun-routing-${process.pid}-absent.token`),
  baseUrl: 'http://127.0.0.1:9/v1',
  autoCreate: false,
})

const handler = routes[0]?.handler
const call = async (body) => {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.url = '/plugins/rayrun'
  req.headers = {}
  const res = {
    status: 0,
    writeHead(status) {
      this.status = status
    },
    end(text) {
      this.body = text
    },
  }
  await handler(req, res)
  return JSON.parse(res.body)
}

const guard = guards[0]
const execFor = (name, sessionId) => ({ name, agent: { session: { id: sessionId } } })
const denial = (name, sessionId) => guard(execFor(name, sessionId))

const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('a guard is registered for tool routing', () => {
  assert.equal(guards.length, 1)
})

check('local mode leaves every tool alone', async () => {
  await call({ action: 'task.target.set', sessionId: 's1', target: 'local' })
  for (const name of ['pwsh', 'bash', 'write', 'edit', 'read']) {
    assert.equal(denial(name, 's1'), undefined, `${name} should pass in local mode`)
  }
})

check('cloud mode refuses local write and execute tools', async () => {
  const reply = await call({ action: 'task.target.set', sessionId: 's1', target: 'cloud' })
  assert.equal(reply.ok, true)
  for (const name of ['pwsh', 'bash', 'write', 'edit']) {
    const reason = denial(name, 's1')
    assert.equal(typeof reason, 'string', `${name} should be refused in cloud mode`)
    assert.match(reason, /云上电脑/)
    assert.match(reason, /rayrun_exec/)
  }
})

check('cloud mode still allows reads and the cloud tools', async () => {
  for (const name of ['read', 'read_image', 'glob', 'grep', 'rayrun_exec', 'rayrun_files', 'rayrun_dsh', 'rayrun_workspace']) {
    assert.equal(denial(name, 's1'), undefined, `${name} should stay usable in cloud mode`)
  }
})

check('the route is per session', async () => {
  await call({ action: 'task.target.set', sessionId: 's2', target: 'local' })
  assert.equal(typeof denial('pwsh', 's1'), 'string')
  assert.equal(denial('pwsh', 's2'), undefined)
})

check('switching back to local lifts the gate', async () => {
  await call({ action: 'task.target.set', sessionId: 's1', target: 'local' })
  assert.equal(denial('pwsh', 's1'), undefined)
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
globalThis.fetch = realFetch
if (failed) process.exitCode = 1
