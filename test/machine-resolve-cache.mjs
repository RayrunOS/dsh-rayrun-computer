/**
 * Checks the machine-lookup fast path used by the runtime RPCs:
 *
 *   - an overview primes the pin, so the next `runtime.get` skips the list GET;
 *   - a second call inside the 30s window also skips the machine-list GET;
 *   - after the window the list is read again;
 *   - a sandbox-level 409/404 drops the pin, so the next call lists again;
 *   - an unrelated 503 or a runtime conflict keeps the pin.
 *
 * A fake Rayrun API stands in for the platform. The test runs under a temporary
 * HOME so a developer's ~/.rayrun/dsh.json cannot redirect the calls.
 *
 *   node test/machine-resolve-cache.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

process.env.HOME = mkdtempSync(path.join(tmpdir(), 'rayrun-machine-cache-home-'))
delete process.env.RAYRUN_TOKEN
const { apply } = await import('../index.js')

const NAME = 'dsh-rayrun-computer'
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (String(url).includes(`${NAME}/latest`)) return { ok: false, status: 404, json: async () => ({}) }
  return realFetch(url, init)
}

const ID = 'sb-bench-0001'
const state = { stopped: false, runtimeMissing: false, runtimeFailure: false, runtimeConflict: false }
const requests = []
const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}
const machine = () => ({
  id: ID,
  name: 'bench',
  agent: 'a@1',
  status: state.stopped ? 'Stopped' : 'Running',
  remote_desktop: false,
  ingress: [],
  credentials: [],
})

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  for await (const _ of req) { /* drain */ }
  requests.push(`${req.method} ${url.pathname}`)
  if (req.headers.authorization !== 'Bearer test-token') {
    json(res, 401, { error: 'unauthorized' })
    return
  }
  if (url.pathname === '/v1/sandboxes' && req.method === 'GET') {
    json(res, 200, { sandboxes: [machine()] })
    return
  }
  if (url.pathname === '/v1/agents' && req.method === 'GET') {
    json(res, 200, { agents: [] })
    return
  }
  if ((url.pathname === '/v1/billing/balance' || url.pathname === '/v1/usage') && req.method === 'GET') {
    json(res, 200, {})
    return
  }
  if (url.pathname === `/v1/sandboxes/${ID}` && req.method === 'GET') {
    json(res, 200, machine())
    return
  }
  if (url.pathname === `/v1/sandboxes/${ID}/runtimes` && req.method === 'GET') {
    if (state.stopped) {
      json(res, 409, { error: 'sandbox_not_running' })
      return
    }
    if (state.runtimeMissing) {
      json(res, 404, { error: 'not_found' })
      return
    }
    if (state.runtimeFailure) {
      json(res, 503, { error: 'internal_error' })
      return
    }
    if (state.runtimeConflict) {
      json(res, 409, { error: 'guestd_outdated' })
      return
    }
    json(res, 200, { runtimes: [{ name: 'bot-host', state: 'running' }] })
    return
  }
  json(res, 404, { error: 'not_found' })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`

const store = { resolve: async () => ({ value: 'test-token' }), set: async () => {}, unset: async () => {} }
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
  get: (name) => (name === 'credentials' ? store : undefined),
  tools: {
    register() {},
    guard() {
      return () => {}
    },
  },
}

apply(ctx, { baseUrl, token: 'test-token', autoCreate: false, sandbox_name: 'bench' })
assert.equal(routes.length, 1, 'the RPC route is registered once')
const handler = routes[0].handler
const rpc = async (body) => {
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
  return { status: res.status, json: JSON.parse(res.body) }
}
const runtimeGet = () => rpc({ action: 'runtime.get', sandbox: 'bench', name: 'bot-host' })

// Keep every pin timestamp on one controllable clock.
let clock = Date.now()
const realNow = Date.now
Date.now = () => clock

const reset = () => { requests.length = 0 }
const LIST = 'GET /v1/sandboxes'
const RUNTIMES = `GET /v1/sandboxes/${ID}/runtimes`

const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('an overview primes the next runtime.get', async () => {
  reset()
  const overview = await rpc({ action: 'overview' })
  assert.equal(overview.json.ok, true)
  assert.equal(overview.json.machines.length, 1)
  assert.deepEqual(
    requests.slice(0, 4).sort(),
    ['GET /v1/agents', 'GET /v1/billing/balance', 'GET /v1/sandboxes', 'GET /v1/usage'],
  )
  const marked = requests.length

  const reply = await runtimeGet()
  assert.equal(reply.json.ok, true)
  assert.equal(reply.json.runtime.name, 'bot-host')
  assert.deepEqual(requests.slice(marked), [RUNTIMES], 'the overview pin removed the list GET')
})

check('a second call inside the window skips the list', async () => {
  reset()
  const reply = await runtimeGet()
  assert.equal(reply.json.ok, true)
  assert.deepEqual(requests, [RUNTIMES])
})

check('after the window the machine list is read again', async () => {
  clock += 30_001
  reset()
  const reply = await runtimeGet()
  assert.equal(reply.json.ok, true)
  assert.deepEqual(requests, [LIST, RUNTIMES])
})

check('a sandbox-level 409 drops the pin so the next call lists again', async () => {
  state.stopped = true
  reset()
  const failed = await runtimeGet()
  assert.equal(failed.json.ok, false)
  assert.equal(failed.json.error.code, 'sandbox_not_running')
  assert.deepEqual(requests, [RUNTIMES], 'the cached Running pin was used')

  reset()
  const again = await runtimeGet()
  assert.equal(again.json.ok, false)
  assert.deepEqual(requests, [LIST, RUNTIMES], 'the failed call must not leave a trusted pin')

  state.stopped = false
  reset()
  const recovered = await runtimeGet()
  assert.equal(recovered.json.ok, true)
  assert.deepEqual(requests, [LIST, RUNTIMES])
})

check('a missing runtime (404) also drops the pin', async () => {
  state.runtimeMissing = true
  reset()
  const failed = await runtimeGet()
  assert.equal(failed.json.ok, false)
  assert.equal(failed.json.error.code, 'not_found')
  assert.deepEqual(requests, [RUNTIMES])

  state.runtimeMissing = false
  reset()
  const recovered = await runtimeGet()
  assert.equal(recovered.json.ok, true)
  assert.deepEqual(requests, [LIST, RUNTIMES])
})

check('an unrelated 503 keeps the pin', async () => {
  state.runtimeFailure = true
  reset()
  const failed = await runtimeGet()
  assert.equal(failed.json.ok, false)
  assert.equal(failed.json.error.code, 'internal_error')
  assert.deepEqual(requests, [RUNTIMES], 'the cached Running pin was used')

  state.runtimeFailure = false
  reset()
  const recovered = await runtimeGet()
  assert.equal(recovered.json.ok, true)
  assert.deepEqual(requests, [RUNTIMES], 'no list GET after an unrelated 503')
})

check('a runtime conflict (guestd_outdated) keeps the pin', async () => {
  state.runtimeConflict = true
  reset()
  const failed = await runtimeGet()
  assert.equal(failed.json.ok, false)
  assert.equal(failed.json.error.code, 'guestd_outdated')
  assert.deepEqual(requests, [RUNTIMES], 'the cached Running pin was used')

  state.runtimeConflict = false
  reset()
  const recovered = await runtimeGet()
  assert.equal(recovered.json.ok, true)
  assert.deepEqual(requests, [RUNTIMES], 'no list GET after a runtime conflict')
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
Date.now = realNow
globalThis.fetch = realFetch
server.close()
if (failed) process.exitCode = 1
