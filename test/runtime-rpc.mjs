/**
 * Contract checks for the host-callable runtime surface on `/plugins/rayrun/rpc`:
 * `runtime.put/list/get/start/stop/restart/delete`.
 *
 * A fake Rayrun API stands in for the platform (ADR-036), so the tests pin the
 * request bodies, the explicit-sandbox rule, the read-back shapes and the
 * stable error codes without a real machine.
 *
 *   node test/runtime-rpc.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { apply } from '../index.js'

const NAME = 'dsh-rayrun-computer'
const realFetch = globalThis.fetch

// Keep the plugin's update check off the network.
globalThis.fetch = async (url, init) => {
  if (String(url).includes(NAME)) return { ok: false, status: 404, json: async () => ({}) }
  return realFetch(url, init)
}

delete process.env.RAYRUN_TOKEN

const machine = (id, name, status) => ({
  id,
  name,
  agent: 'deepseek-harness@1',
  status,
  cpu_cores: 2,
  memory_mb: 2048,
  workspace_mb: 10240,
  remote_desktop: false,
})

/** The fake platform state. */
const cloud = {
  machines: [
    machine('sb-test-0001', 'box', 'Running'),
    machine('sb-test-0002', 'sleepy', 'Stopped'),
    machine('sb-test-0003', 'frozen', 'Paused'),
  ],
  specs: new Map(),
  states: new Map(),
  puts: [],
  actions: [],
  requests: [],
  fault: null,
  listStatusError: null,
}

function seed(name, spec, state = 'running') {
  cloud.specs.set(name, { name, ...spec })
  cloud.states.set(name, { state, pid: state === 'running' ? 123 : 0, restarts: 0 })
}

seed(
  'bot-host',
  {
    argv: ['/usr/bin/node', '/workspace/bot.js'],
    workdir: '/workspace',
    credentials: ['model-key'],
    restart: 'always',
    autostart: true,
    keep_alive: true,
    stop_signal: 'SIGTERM',
    stop_timeout_seconds: 10,
  },
  'running',
)

function view(name, sb) {
  const spec = cloud.specs.get(name)
  if (!spec) return null
  const live = cloud.states.get(name) ?? {}
  if (sb.status === 'Paused') return { name, spec, state: 'paused', paused: true, restarts: live.restarts ?? 0 }
  if (sb.status === 'Stopped') return { name, spec, state: 'stopped', restarts: live.restarts ?? 0 }
  return {
    name,
    spec,
    state: live.state ?? 'unknown',
    ...(live.pid ? { pid: live.pid } : {}),
    restarts: live.restarts ?? 0,
  }
}

function listFor(sb) {
  return [...cloud.specs.keys()].map((name) => {
    const item = view(name, sb)
    if (cloud.listStatusError) return { ...item, state: 'unknown', status_error: cloud.listStatusError }
    return item
  })
}

const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks)
  cloud.requests.push({ method: req.method, path: url.pathname })
  if (req.headers.authorization !== 'Bearer test-token') {
    json(res, 401, { error: 'unauthorized' })
    return
  }
  if (cloud.fault && req.method === cloud.fault.method && cloud.fault.match(url.pathname)) {
    const fault = cloud.fault
    cloud.fault = null
    json(res, fault.status, fault.body)
    return
  }
  if (req.method === 'GET' && url.pathname === '/v1/sandboxes') {
    json(res, 200, { sandboxes: cloud.machines })
    return
  }
  const one = /^\/v1\/sandboxes\/([^/]+)$/.exec(url.pathname)
  if (req.method === 'GET' && one) {
    const found = cloud.machines.find((item) => item.id === one[1])
    if (!found) json(res, 404, { error: 'not_found' })
    else json(res, 200, found)
    return
  }
  const list = /^\/v1\/sandboxes\/([^/]+)\/runtimes$/.exec(url.pathname)
  if (req.method === 'GET' && list) {
    const sb = cloud.machines.find((item) => item.id === list[1])
    if (!sb) {
      json(res, 404, { error: 'not_found' })
      return
    }
    json(res, 200, { runtimes: listFor(sb) })
    return
  }
  const put = /^\/v1\/sandboxes\/([^/]+)\/runtimes\/([^/]+)$/.exec(url.pathname)
  if (req.method === 'PUT' && put) {
    const sb = cloud.machines.find((item) => item.id === put[1])
    if (!sb) {
      json(res, 404, { error: 'not_found' })
      return
    }
    const name = decodeURIComponent(put[2])
    const body = JSON.parse(raw)
    const existed = cloud.specs.has(name)
    cloud.puts.push({ name, body })
    cloud.specs.set(name, { name, ...body })
    if (sb.status === 'Running') {
      cloud.states.set(name, { state: 'running', pid: 123, restarts: cloud.states.get(name)?.restarts ?? 0 })
    } else {
      cloud.states.set(name, { state: sb.status === 'Paused' ? 'paused' : 'stopped', pid: 0, restarts: 0 })
    }
    json(res, 200, { applied: sb.status === 'Running', restarted: sb.status === 'Running' && existed })
    return
  }
  const action = /^\/v1\/sandboxes\/([^/]+)\/runtimes\/([^/]+)\/(start|stop|restart)$/.exec(url.pathname)
  if (req.method === 'POST' && action) {
    const sb = cloud.machines.find((item) => item.id === action[1])
    if (!sb) {
      json(res, 404, { error: 'not_found' })
      return
    }
    const name = decodeURIComponent(action[2])
    if (!cloud.specs.has(name)) {
      json(res, 404, { error: 'not_found' })
      return
    }
    if (sb.status === 'Paused') {
      json(res, 503, { error: 'sandbox_paused' })
      return
    }
    if (sb.status !== 'Running') {
      json(res, 409, { error: 'sandbox_not_running' })
      return
    }
    const verb = action[3]
    const live = cloud.states.get(name) ?? { restarts: 0 }
    cloud.actions.push({ name, verb })
    if (verb === 'stop') cloud.states.set(name, { state: 'stopped', pid: 0, restarts: live.restarts ?? 0 })
    else if (verb === 'restart') {
      cloud.states.set(name, { state: 'running', pid: 124, restarts: (live.restarts ?? 0) + 1 })
    } else cloud.states.set(name, { state: 'running', pid: 123, restarts: live.restarts ?? 0 })
    res.writeHead(204)
    res.end()
    return
  }
  const del = /^\/v1\/sandboxes\/([^/]+)\/runtimes\/([^/]+)$/.exec(url.pathname)
  if (req.method === 'DELETE' && del) {
    const sb = cloud.machines.find((item) => item.id === del[1])
    if (!sb) {
      json(res, 404, { error: 'not_found' })
      return
    }
    const name = decodeURIComponent(del[2])
    cloud.specs.delete(name)
    cloud.states.delete(name)
    res.writeHead(204)
    res.end()
    return
  }
  json(res, 404, { error: 'not_found' })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
const store = { resolve: async () => undefined, set: async () => {}, unset: async () => {} }

function hostFor(config) {
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
      return undefined
    },
    tools: {
      register() {},
      guard() {
        return () => {}
      },
    },
  }
  apply(ctx, { baseUrl, autoCreate: true, ...config })
  assert.equal(routes.length, 1, 'the RPC route is registered once')
  return routes[0].handler
}

async function rpc(handler, body, headers = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.url = '/plugins/rayrun'
  req.headers = headers
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
  return { status: res.status, text: res.body ?? '', json: JSON.parse(res.body) }
}

const checks = []
const check = (name, fn) => checks.push({ name, fn })
const host = hostFor({ token: 'test-token' })
const noToken = hostFor({ token_file: path.join(tmpdir(), `runtime-rpc-${process.pid}-absent.token`) })
const fullSpec = {
  argv: ['/usr/bin/node', '/workspace/bot.js'],
  workdir: '/workspace',
  env: { MODE: 'bot' },
  credentials: ['model-key'],
  restart: 'always',
  autostart: false,
  keep_alive: true,
  stop_signal: 'SIGTERM',
  stop_timeout_seconds: 10,
}
const putBody = (extra = {}) => ({
  action: 'runtime.put',
  sandbox: 'box',
  name: 'worker',
  spec: { argv: ['/usr/bin/node', '/workspace/worker.js'] },
  ...extra,
})

try {
  check('a cross-origin runtime.put is refused before anything runs', async () => {
    const before = cloud.requests.length
    const reply = await rpc(host, putBody(), { origin: 'http://evil.example' })
    assert.equal(reply.status, 403)
    assert.equal(reply.json.error.code, 'origin_mismatch')
    assert.equal(cloud.requests.length, before)
  })

  check('without a Rayrun token runtime.list fails with token_required', async () => {
    const before = cloud.requests.length
    const reply = await rpc(noToken, { action: 'runtime.list', sandbox: 'box' })
    assert.equal(reply.json.ok, false)
    assert.equal(reply.json.error.code, 'token_required')
    assert.equal(cloud.requests.length, before)
  })

  check('an explicit missing sandbox is sandbox_missing and never creates one', async () => {
    const before = cloud.requests.length
    const reply = await rpc(host, { action: 'runtime.list', sandbox: 'no-such-box' })
    assert.equal(reply.json.ok, false)
    assert.equal(reply.json.error.code, 'sandbox_missing')
    assert.equal(cloud.requests.slice(before).filter((item) => item.path.includes('/runtimes')).length, 0)
    assert.equal(cloud.requests.filter((item) => item.method === 'POST' && item.path === '/v1/sandboxes').length, 0)
  })

  check('names and specs are validated before the API is touched', async () => {
    const before = cloud.requests.length
    const badName = await rpc(host, putBody({ name: 'Bot_Host' }))
    assert.equal(badName.json.error.code, 'invalid_runtime_name')
    const cases = [
      {},
      { argv: [] },
      { argv: ['ok'], credentials: [{ name: 'model-key', value: 'secret' }] },
      { argv: ['ok'], restart: 'sometimes' },
      { argv: ['ok'], autostart: 'yes' },
      { argv: ['ok'], keep_alive: 1 },
      { argv: ['ok'], stop_signal: 'SIGUSR1' },
      { argv: ['ok'], stop_timeout_seconds: 31 },
      { argv: ['ok'], name: 'bot-host' },
      { argv: ['ok'], token: 'secret' },
      { argv: ['ok'], env: { MODE: 1 } },
    ]
    for (const spec of cases) {
      const reply = await rpc(host, putBody({ spec }))
      assert.equal(reply.json.ok, false, JSON.stringify(spec))
      assert.equal(reply.json.error.code, 'invalid_runtime_spec', JSON.stringify(spec))
    }
    assert.equal(cloud.requests.length, before, 'nothing reached the fake platform')
    assert.equal(cloud.puts.length, 0, 'no PUT body carried a rejected spec')
  })

  check('runtime.put forwards only declared fields and returns the read-back', async () => {
    const reply = await rpc(host, putBody({ spec: fullSpec }))
    assert.equal(reply.json.ok, true, JSON.stringify(reply.json))
    assert.equal(reply.json.sandbox, 'box')
    assert.equal(reply.json.machine_id, 'sb-test-0001')
    assert.equal(reply.json.applied, true)
    assert.equal(reply.json.restarted, false)
    assert.equal(reply.json.runtime.name, 'worker')
    assert.equal(reply.json.runtime.state, 'running')
    assert.deepEqual(cloud.puts.at(-1), { name: 'worker', body: fullSpec })
    assert.equal(Object.hasOwn(cloud.puts.at(-1).body, 'name'), false, 'name travels in the path, not the body')
    assert.doesNotMatch(reply.text, /test-token|Bearer/)

    const defaults = await rpc(host, putBody({ name: 'manual', spec: { argv: ['/bin/true'] } }))
    assert.equal(defaults.json.ok, true)
    assert.deepEqual(cloud.puts.at(-1).body, { argv: ['/bin/true'] }, 'omitted fields stay omitted')
    assert.equal(Object.hasOwn(cloud.puts.at(-1).body, 'autostart'), false, 'platform default stays authoritative')
  })

  check('runtime.list and runtime.get expose the platform view', async () => {
    const list = await rpc(host, { action: 'runtime.list', sandbox: 'box' })
    assert.equal(list.json.ok, true)
    const names = list.json.runtimes.map((item) => item.name).sort()
    assert.deepEqual(names, ['bot-host', 'manual', 'worker'])
    const got = await rpc(host, { action: 'runtime.get', sandbox: 'box', name: 'bot-host' })
    assert.equal(got.json.ok, true)
    assert.equal(got.json.runtime.state, 'running')
    assert.equal(got.json.runtime.pid, 123)
    assert.deepEqual(got.json.runtime.spec.credentials, ['model-key'])
    const missing = await rpc(host, { action: 'runtime.get', sandbox: 'box', name: 'absent' })
    assert.equal(missing.json.ok, true)
    assert.equal(missing.json.runtime, null)
  })

  check('a stopped machine persists the spec but reports applied false', async () => {
    const reply = await rpc(
      host,
      putBody({ sandbox: 'sleepy', name: 'later', spec: { argv: ['/bin/true'], autostart: true } }),
    )
    assert.equal(reply.json.ok, true)
    assert.equal(reply.json.applied, false)
    assert.equal(reply.json.restarted, false)
    assert.equal(reply.json.runtime.state, 'stopped')
    const start = await rpc(host, { action: 'runtime.start', sandbox: 'sleepy', name: 'later' })
    assert.equal(start.json.ok, false)
    assert.equal(start.json.error.code, 'sandbox_not_running')
    const paused = await rpc(host, { action: 'runtime.start', sandbox: 'frozen', name: 'bot-host' })
    assert.equal(paused.json.ok, false)
    assert.equal(paused.json.error.code, 'sandbox_paused')
  })

  check('start, stop and restart hit the platform and return the read-back', async () => {
    const started = await rpc(host, { action: 'runtime.start', sandbox: 'box', name: 'worker' })
    assert.equal(started.json.ok, true)
    assert.equal(started.json.runtime.state, 'running')
    const stopped = await rpc(host, { action: 'runtime.stop', sandbox: 'box', name: 'worker' })
    assert.equal(stopped.json.ok, true)
    assert.equal(stopped.json.runtime.state, 'stopped')
    const restarted = await rpc(host, { action: 'runtime.restart', sandbox: 'box', name: 'bot-host' })
    assert.equal(restarted.json.ok, true)
    assert.equal(restarted.json.runtime.state, 'running')
    assert.equal(restarted.json.runtime.restarts, 1)
    assert.deepEqual(cloud.actions, [
      { name: 'worker', verb: 'start' },
      { name: 'worker', verb: 'stop' },
      { name: 'bot-host', verb: 'restart' },
    ])
  })

  check('runtime.delete is idempotent', async () => {
    const first = await rpc(host, { action: 'runtime.delete', sandbox: 'box', name: 'manual' })
    assert.equal(first.json.ok, true)
    assert.equal(first.json.deleted, true)
    assert.equal(first.json.name, 'manual')
    const gone = await rpc(host, { action: 'runtime.get', sandbox: 'box', name: 'manual' })
    assert.equal(gone.json.runtime, null)
    const again = await rpc(host, { action: 'runtime.delete', sandbox: 'box', name: 'manual' })
    assert.equal(again.json.ok, true)
    assert.equal(again.json.deleted, true)
  })

  check('platform error codes pass through stably', async () => {
    cloud.fault = {
      method: 'PUT',
      match: (pathname) => pathname.endsWith('/runtimes/new-host'),
      status: 409,
      body: { error: 'guestd_outdated' },
    }
    const outdated = await rpc(host, putBody({ name: 'new-host' }))
    assert.equal(outdated.json.ok, false)
    assert.equal(outdated.json.error.code, 'guestd_outdated')
    assert.equal(outdated.json.error.status, 409)

    cloud.fault = {
      method: 'POST',
      match: (pathname) => pathname.endsWith('/runtimes/worker/start'),
      status: 503,
      body: { error: 'sandbox_paused' },
    }
    const paused = await rpc(host, { action: 'runtime.start', sandbox: 'box', name: 'worker' })
    assert.equal(paused.json.error.code, 'sandbox_paused')

    cloud.fault = {
      method: 'POST',
      match: (pathname) => pathname.endsWith('/runtimes/worker/restart'),
      status: 404,
      body: { error: 'not_found' },
    }
    const missing = await rpc(host, { action: 'runtime.restart', sandbox: 'box', name: 'worker' })
    assert.equal(missing.json.error.code, 'runtime_not_found')

    cloud.fault = {
      method: 'PUT',
      match: (pathname) => pathname.endsWith('/runtimes/bad-spec'),
      status: 400,
      body: { error: 'invalid_request', details: { field: 'argv', reason: 'must have 1..64 items' } },
    }
    const invalid = await rpc(host, putBody({ name: 'bad-spec' }))
    assert.equal(invalid.json.error.code, 'invalid_request')
    assert.match(invalid.json.error.message, /argv: must have 1\.\.64 items/)

    // A write's 404 can also mean this daemon has no runtimes route, so it is
    // passed through rather than relabelled as a missing sandbox.
    cloud.fault = {
      method: 'PUT',
      match: (pathname) => pathname.endsWith('/runtimes/gone'),
      status: 404,
      body: { error: 'not_found' },
    }
    const gone = await rpc(host, putBody({ name: 'gone' }))
    assert.equal(gone.json.error.code, 'not_found')

    // A route-level 404 (no JSON error envelope) means this deployment has no
    // runtimes API at all, which is distinct from a missing runtime.
    cloud.fault = {
      method: 'GET',
      match: (pathname) => pathname.endsWith('/runtimes'),
      status: 404,
      body: {},
    }
    const unavailable = await rpc(host, { action: 'runtime.list', sandbox: 'box' })
    assert.equal(unavailable.json.error.code, 'runtimes_unavailable')
    assert.equal(unavailable.json.error.status, 404)
  })

  check('list and get surface guestd_outdated without failing', async () => {
    cloud.listStatusError = 'guestd_outdated'
    const list = await rpc(host, { action: 'runtime.list', sandbox: 'box' })
    assert.equal(list.json.ok, true)
    assert.equal(list.json.runtimes[0].state, 'unknown')
    assert.equal(list.json.runtimes[0].status_error, 'guestd_outdated')
    const got = await rpc(host, { action: 'runtime.get', sandbox: 'box', name: 'bot-host' })
    assert.equal(got.json.ok, true)
    assert.equal(got.json.runtime.status_error, 'guestd_outdated')
    cloud.listStatusError = null
  })

  check('no request ever created a sandbox', () => {
    assert.deepEqual(
      cloud.requests.filter((item) => item.method === 'POST' && item.path === '/v1/sandboxes'),
      [],
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
      console.log(`     ${error?.stack ?? error?.message ?? error}`)
    }
  }
  console.log(`${checks.length - failed}/${checks.length} checks passed`)
  if (failed) process.exitCode = 1
} finally {
  globalThis.fetch = realFetch
  await new Promise((resolve) => server.close(resolve))
}
