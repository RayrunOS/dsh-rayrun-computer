/**
 * Checks the file-call fast path over the real `apply` export:
 *
 *   - a pinned Running machine is reused without a status GET inside the TTL;
 *   - after the TTL the status is checked again;
 *   - a sandbox that stopped inside the TTL answers 409, is re-resolved/woken,
 *     and the idempotent file call is replayed once;
 *   - a 404 drops the pin but is not replayed (a missing file must stay cheap);
 *   - non-file tools keep checking the machine on every call.
 *
 * A fake Rayrun API stands in for the platform. The test runs under a temporary
 * HOME so a developer's ~/.rayrun/dsh.json cannot redirect the calls.
 *
 *   node test/file-resolve-cache.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.HOME = mkdtempSync(path.join(tmpdir(), 'rayrun-file-cache-home-'))
delete process.env.RAYRUN_TOKEN
const { apply } = await import('../index.js')

const NAME = 'dsh-rayrun-computer'
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (String(url).includes(`${NAME}/latest`)) return { ok: false, status: 404, json: async () => ({}) }
  return realFetch(url, init)
}

const ID = 'sb-bench-0001'
const state = { stopped: false, paused: false, missing: false }
const requests = []
const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}
const machine = () => ({
  id: ID,
  name: 'bench',
  agent: 'a@1',
  status: state.paused ? 'Paused' : state.stopped ? 'Stopped' : 'Running',
  remote_desktop: false,
  ingress: [],
  credentials: [],
})
const unavailable = (res) => {
  if (state.paused) {
    json(res, 503, { error: 'sandbox_paused' })
    return true
  }
  if (state.stopped) {
    json(res, 409, { error: 'sandbox_not_running' })
    return true
  }
  if (state.missing) {
    json(res, 404, { error: 'not_found' })
    return true
  }
  return false
}

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
  if (url.pathname === `/v1/sandboxes/${ID}` && req.method === 'GET') {
    json(res, 200, machine())
    return
  }
  if (url.pathname === `/v1/sandboxes/${ID}/start` && req.method === 'POST') {
    state.stopped = false
    json(res, 200, machine())
    return
  }
  if (url.pathname === `/v1/sandboxes/${ID}/resume` && req.method === 'POST') {
    state.paused = false
    json(res, 200, machine())
    return
  }
  if (url.pathname === `/v1/sandboxes/${ID}/exec` && req.method === 'POST') {
    json(res, 200, { exec_id: 'e1', exit_code: 0, stdout: '', stderr: '', duration_ms: 1, timed_out: false, truncated: false })
    return
  }
  if (url.pathname === `/v1/sandboxes/${ID}/files` && req.method === 'GET') {
    if (unavailable(res)) return
    json(res, 200, { entries: [{ type: 'file', name: 'a.txt', size: 3 }] })
    return
  }
  if (url.pathname.startsWith(`/v1/sandboxes/${ID}/files/`)) {
    if (unavailable(res)) return
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end('abc')
      return
    }
    if (req.method === 'PUT') {
      json(res, 201, { path: url.pathname.split('/files/')[1], size: 1 })
      return
    }
  }
  json(res, 404, { error: 'not_found' })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`

const store = { resolve: async () => ({ value: 'test-token' }), set: async () => {}, unset: async () => {} }
const tools = new Map()
const child = {
  effect(fn) {
    fn()
    return () => {}
  },
  get: (name) => (name === 'credentials' ? store : undefined),
  webServer: { register: () => () => {}, getOrigin: () => 'http://127.0.0.1:1' },
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
    register(tool) {
      tools.set(tool.name, tool)
    },
    guard() {
      return () => {}
    },
  },
}

apply(ctx, { baseUrl, token: 'test-token', autoCreate: false, sandbox_name: 'bench' })
const files = tools.get('rayrun_files')
const execTool = tools.get('rayrun_exec')
assert.ok(files && execTool, 'file and exec tools are registered')
const exec = { signal: undefined, agent: {} }

// Keep every pin timestamp on one controllable clock.
let clock = Date.now()
const realNow = Date.now
Date.now = () => clock

const reset = () => { requests.length = 0 }
const list = () => files.execute({ action: 'list', sandbox: 'bench', path: '' }, exec)

const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('the first call resolves by name, then the pinned machine is reused', async () => {
  reset()
  await list()
  assert.deepEqual(requests, ['GET /v1/sandboxes', `GET /v1/sandboxes/${ID}/files`])
  reset()
  await list()
  assert.deepEqual(requests, [`GET /v1/sandboxes/${ID}/files`], 'no status GET inside the TTL')
})

check('the status is checked again after the trust window', async () => {
  clock += 30_001
  reset()
  await list()
  assert.deepEqual(requests, [`GET /v1/sandboxes/${ID}`, `GET /v1/sandboxes/${ID}/files`])
})

check('a stop inside the trust window is woken and the file call is replayed once', async () => {
  state.stopped = true
  reset()
  const text = await list()
  assert.match(text, /a\.txt/)
  assert.deepEqual(requests, [
    `GET /v1/sandboxes/${ID}/files`,
    'GET /v1/sandboxes',
    `POST /v1/sandboxes/${ID}/start`,
    `GET /v1/sandboxes/${ID}`,
    `GET /v1/sandboxes/${ID}/files`,
  ])
})

check('a paused sandbox is resumed and the file call is replayed once', async () => {
  state.paused = true
  reset()
  const text = await list()
  assert.match(text, /a\.txt/)
  assert.deepEqual(requests, [
    `GET /v1/sandboxes/${ID}/files`,
    'GET /v1/sandboxes',
    `POST /v1/sandboxes/${ID}/resume`,
    `GET /v1/sandboxes/${ID}`,
    `GET /v1/sandboxes/${ID}/files`,
  ])
})

check('a 404 drops the pin without replaying the call', async () => {
  state.missing = true
  reset()
  await assert.rejects(() => list(), (error) => error?.status === 404)
  assert.deepEqual(requests, [`GET /v1/sandboxes/${ID}/files`], 'one call, no replay')

  state.missing = false
  reset()
  await list()
  assert.deepEqual(requests, ['GET /v1/sandboxes', `GET /v1/sandboxes/${ID}/files`], 'the next call re-resolves')
})

check('upload and download stay one request inside the TTL', async () => {
  reset()
  const uploaded = await files.execute({ action: 'upload', sandbox: 'bench', path: 'b.txt', text: 'x' }, exec)
  assert.match(uploaded, /Uploaded 1 B to b\.txt/)
  assert.deepEqual(requests, [`PUT /v1/sandboxes/${ID}/files/b.txt`])

  reset()
  const downloaded = await files.execute({ action: 'download', sandbox: 'bench', path: 'a.txt' }, exec)
  assert.equal(downloaded, 'abc')
  assert.deepEqual(requests, [`GET /v1/sandboxes/${ID}/files/a.txt`])
})

check('non-file tools keep their full status check', async () => {
  reset()
  await execTool.execute({ argv: ['true'], sandbox: 'bench' }, exec)
  await execTool.execute({ argv: ['true'], sandbox: 'bench' }, exec)
  assert.deepEqual(
    requests.filter((entry) => entry === `GET /v1/sandboxes/${ID}`).length,
    2,
    'one machine GET per exec, even inside the file TTL',
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
Date.now = realNow
globalThis.fetch = realFetch
server.close()
if (failed) process.exitCode = 1
