/**
 * Contract checks for credential writes and machine-create idempotency on
 * `/plugins/rayrun/rpc`:
 *
 *   - credentials.save / modelCredential.save write one Rayrun credential
 *     without creating a machine and never echo the key;
 *   - a machine-create failure removes only a credential this call created;
 *   - machine.create sends Idempotency-Key and reuses it on the cold-start retry.
 *
 * A fake Rayrun API stands in for the platform. The test runs under a temporary
 * HOME so a developer's saved ~/.rayrun/dsh.json cannot redirect the calls.
 *
 *   node test/credential-rpc.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

process.env.HOME = mkdtempSync(path.join(tmpdir(), 'rayrun-credential-home-'))
delete process.env.RAYRUN_TOKEN
const { apply } = await import('../index.js')

const NAME = 'dsh-rayrun-computer'
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (String(url).includes(`${NAME}/latest`)) return { ok: false, status: 404, json: async () => ({}) }
  return realFetch(url, init)
}

const cloud = {
  credentials: new Map(),
  posts: [],
  deletes: [],
  machines: [],
  creates: [],
  createMode: 'ok',
  failedOnce: false,
}
let nextID = 1

const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks)
  if (req.headers.authorization !== 'Bearer test-token') {
    json(res, 401, { error: 'unauthorized' })
    return
  }

  if (url.pathname === '/v1/credentials' && req.method === 'POST') {
    const body = JSON.parse(raw)
    cloud.posts.push(body)
    cloud.credentials.set(body.name, body)
    json(res, 201, { name: body.name, provider: body.provider })
    return
  }
  if (url.pathname === '/v1/credentials' && req.method === 'GET') {
    const credentials = [...cloud.credentials.values()].map((item) => ({
      name: item.name,
      provider: item.provider,
      slot: 'DEEPSEEK_API_KEY',
      secret_mask: '',
    }))
    json(res, 200, { credentials })
    return
  }
  const credential = /^\/v1\/credentials\/([^/]+)$/.exec(url.pathname)
  if (credential && req.method === 'DELETE') {
    const name = decodeURIComponent(credential[1])
    cloud.deletes.push(name)
    if (!cloud.credentials.delete(name)) {
      json(res, 404, { error: 'not_found' })
      return
    }
    res.writeHead(204)
    res.end()
    return
  }

  if (url.pathname === '/v1/sandboxes' && req.method === 'GET') {
    json(res, 200, { sandboxes: cloud.machines })
    return
  }
  if (url.pathname === '/v1/sandboxes' && req.method === 'POST') {
    const body = JSON.parse(raw)
    cloud.creates.push({ body, idempotencyKey: req.headers['idempotency-key'] ?? null })
    if (cloud.createMode === 'fail') {
      json(res, 400, { error: 'invalid_request', details: { field: 'agent', reason: 'rejected by fake' } })
      return
    }
    if (cloud.createMode === 'conflict') {
      json(res, 409, { error: 'name_conflict' })
      return
    }
    if (cloud.createMode === 'coldstart' && !cloud.failedOnce) {
      cloud.failedOnce = true
      json(res, 500, { error: 'create_failed', message: 'vsock guest agent never answered' })
      return
    }
    const machine = {
      id: `sb-test-${String(nextID++).padStart(4, '0')}`,
      name: body.name,
      agent: body.agent,
      status: 'Running',
      cpu_cores: body.cpu_cores,
      memory_mb: body.memory_mb,
      workspace_mb: body.workspace_mb ?? 10240,
      remote_desktop: body.remote_desktop === true,
      credentials: body.credentials ?? [],
    }
    cloud.machines.push(machine)
    json(res, 201, machine)
    return
  }
  const one = /^\/v1\/sandboxes\/([^/]+)$/.exec(url.pathname)
  if (one && req.method === 'GET') {
    const found = cloud.machines.find((item) => item.id === one[1])
    if (!found) json(res, 404, { error: 'not_found' })
    else json(res, 200, found)
    return
  }
  json(res, 404, { error: 'not_found' })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`

const store = { resolve: async () => undefined, set: async () => {}, unset: async () => {} }
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

apply(ctx, { baseUrl, token: 'test-token', autoCreate: true })
assert.equal(routes.length, 1, 'the RPC route is registered once')
const handler = routes[0].handler

async function rpc(body) {
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
  return { status: res.status, text: res.body ?? '', json: JSON.parse(res.body) }
}

const checks = []
const check = (name, fn) => checks.push({ name, fn })
let defaultName = ''

check('credentials.save writes a model credential without creating a machine', async () => {
    const reply = await rpc({ action: 'credentials.save', modelKey: 'fake-secret-1' })
    assert.equal(reply.json.ok, true)
    defaultName = reply.json.credential.name
    assert.match(defaultName, /^dsh-model-/)
    assert.equal(reply.json.credential.provider, 'deepseek')
    assert.equal(reply.json.created, true)
    assert.equal(reply.text.includes('fake-secret-1'), false, 'the response never echoes the key')
    assert.equal(cloud.creates.length, 0, 'no machine was created')
    assert.equal(cloud.posts.at(-1).name, defaultName)
    assert.equal(cloud.posts.at(-1).provider, 'deepseek')
    assert.equal(cloud.posts.at(-1).secret, 'fake-secret-1')
  })

  check('credentials.save rotates an existing binding by name', async () => {
    const created = await rpc({ action: 'credentials.save', name: 'machine-binding', modelKey: 'fake-secret-2' })
    assert.equal(created.json.ok, true)
    assert.equal(created.json.credential.name, 'machine-binding')
    assert.equal(created.json.created, true)

    const rotated = await rpc({ action: 'modelCredential.save', name: 'machine-binding', modelKey: 'fake-secret-3' })
    assert.equal(rotated.json.ok, true)
    assert.equal(rotated.json.credential.name, 'machine-binding')
    assert.equal(rotated.json.created, false)
    assert.equal(cloud.credentials.get('machine-binding').secret, 'fake-secret-3')
    assert.equal(rotated.text.includes('fake-secret-3'), false)
    assert.equal(cloud.creates.length, 0)
  })

  check('credentials.save validates its inputs before the API', async () => {
    const before = cloud.posts.length
    const blank = await rpc({ action: 'credentials.save', modelKey: '   ' })
    assert.equal(blank.json.ok, false)
    assert.equal(blank.json.error.code, 'model_key_required')
    const long = await rpc({ action: 'credentials.save', name: 'x'.repeat(65), modelKey: 'fake-secret' })
    assert.equal(long.json.ok, false)
    assert.equal(long.json.error.code, 'invalid_credential_name')
    assert.equal(cloud.posts.length, before)
  })

  check('a failed create removes only the credential this call created', async () => {
    cloud.credentials.delete(defaultName)
    cloud.createMode = 'fail'
    const before = cloud.deletes.length
    const reply = await rpc({
      action: 'machine.create',
      name: 'cleanup-box',
      modelKey: 'fake-secret-4',
      remote_desktop: false,
    })
    assert.equal(reply.json.ok, false)
    assert.equal(reply.json.error.code, 'invalid_request')
    assert.equal(cloud.creates.length, 1)
    assert.equal(cloud.credentials.has(defaultName), false, 'the new credential was removed')
    assert.deepEqual(cloud.deletes.slice(before), [defaultName])
    cloud.createMode = 'ok'
  })

  check('a failed create keeps a credential that already existed', async () => {
    const saved = await rpc({ action: 'credentials.save', modelKey: 'fake-secret-5' })
    assert.equal(saved.json.created, true)
    cloud.createMode = 'fail'
    const before = cloud.deletes.length
    const reply = await rpc({
      action: 'machine.create',
      name: 'keep-box',
      modelKey: 'fake-secret-6',
      remote_desktop: false,
    })
    assert.equal(reply.json.ok, false)
    assert.equal(cloud.deletes.length, before, 'the pre-existing credential is not removed')
    assert.equal(cloud.credentials.has(defaultName), true)
    cloud.createMode = 'ok'
  })

  check('a successful create binds the credential and does not delete it', async () => {
    const before = cloud.deletes.length
    const reply = await rpc({
      action: 'machine.create',
      name: 'bind-box',
      modelKey: 'fake-secret-7',
      remote_desktop: false,
    })
    assert.equal(reply.json.ok, true)
    assert.equal(cloud.deletes.length, before)
    assert.ok(cloud.creates.at(-1).body.credentials.includes(defaultName))
    assert.ok(reply.json.machine.credentials.includes(defaultName))
    assert.match(reply.json.machine.idempotency_key, /^dsh-create-/)
  })

  check('machine.create reuses one idempotency key on the cold-start retry', async () => {
    cloud.createMode = 'coldstart'
    cloud.failedOnce = false
    const before = cloud.creates.length
    const reply = await rpc({
      action: 'machine.create',
      name: 'retry-box',
      remote_desktop: false,
      idempotency_key: 'create-fixed-key',
    })
    assert.equal(reply.json.ok, true)
    assert.equal(reply.json.machine.idempotency_key, 'create-fixed-key')
    assert.equal(reply.json.machine.retried, true)
    const attempts = cloud.creates.slice(before)
    assert.equal(attempts.length, 2)
    assert.deepEqual(attempts.map((item) => item.idempotencyKey), ['create-fixed-key', 'create-fixed-key'])
    cloud.createMode = 'ok'
  })

  check('a generated idempotency key is sent and returned', async () => {
    const reply = await rpc({ action: 'machine.create', name: 'generated-box', remote_desktop: false })
    assert.equal(reply.json.ok, true)
    assert.match(reply.json.machine.idempotency_key, /^dsh-create-/)
    assert.equal(cloud.creates.at(-1).idempotencyKey, reply.json.machine.idempotency_key)
  })

  check('an oversized idempotency key is refused before the API', async () => {
    const before = cloud.creates.length
    const reply = await rpc({
      action: 'machine.create',
      name: 'bad-key-box',
      remote_desktop: false,
      idempotency_key: 'x'.repeat(129),
    })
    assert.equal(reply.json.ok, false)
    assert.equal(reply.json.error.code, 'invalid_idempotency_key')
    assert.equal(cloud.creates.length, before)
  })

  check('a platform name conflict is reported as name_conflict', async () => {
    cloud.createMode = 'conflict'
    const reply = await rpc({ action: 'machine.create', name: 'duplicate-box', remote_desktop: false })
    assert.equal(reply.json.ok, false)
    assert.equal(reply.json.error.code, 'name_conflict')
    cloud.createMode = 'ok'
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
server.close()
globalThis.fetch = realFetch
console.log(`${checks.length - failed}/${checks.length} checks passed`)
if (failed) process.exitCode = 1
