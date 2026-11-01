/**
 * Negative/security checks for the Rayrun plugin surface.
 *
 * Drives the real `/plugins/rayrun` handler with a fake Harness context, so the
 * origin gate, body limit, action whitelist and token redaction are tested where
 * they actually run — not on a copy of the logic.
 *
 *   node test/security.mjs
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const NAME = 'dsh-rayrun-computer'
const realFetch = globalThis.fetch

// The plugin falls back to ~/.rayrun/token; point it at a file that cannot exist
// so a developer machine's real token never leaks into these assertions.
delete process.env.RAYRUN_TOKEN
const config = {
  token_file: path.join(tmpdir(), `rayrun-security-${process.pid}-absent.token`),
  baseUrl: 'http://127.0.0.1:9/v1',
  autoCreate: false,
}

// Keep the plugin's update check off the network.
globalThis.fetch = async (url, init) => {
  if (String(url).includes(NAME)) return { ok: false, status: 404, json: async () => ({}) }
  return realFetch(url, init)
}

const store = { resolve: async () => undefined, set: async () => {}, unset: async () => {} }

function hostFor() {
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
    get: (name) => {
      if (name === 'credentials') return store
      if (name === 'pluginManager') return undefined
      return undefined
    },
    tools: {
      register() {},
      guard() {
        return () => {}
      },
    },
  }
  apply(ctx, config)
  assert.equal(routes.length, 1, 'the RPC route is registered once')
  return routes[0].handler
}

/** Call the handler and capture status, body, and headers. */
async function request(handler, { method = 'POST', action, body, headers = {} } = {}) {
  const payload = body ?? (action === undefined ? {} : { action })
  const req = Readable.from(method === 'GET' ? [] : [Buffer.from(JSON.stringify(payload))])
  req.method = method
  req.url = method === 'GET' ? `/plugins/rayrun?action=${encodeURIComponent(action)}` : '/plugins/rayrun'
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
  let parsed = null
  try {
    parsed = JSON.parse(res.body)
  } catch {
    parsed = null
  }
  return { status: res.status, text: res.body ?? '', json: parsed }
}

const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('a read-only reply never carries a token', async () => {
  const reply = await request(hostFor(), { method: 'GET', action: 'status' })
  assert.equal(reply.json.ok, true)
  assert.equal(reply.json.connection.token, undefined)
  assert.equal(reply.json.connection.configured, false)
  assert.doesNotMatch(reply.text, /Bearer\s|RAYRUN_TOKEN|sk-[A-Za-z0-9]{16,}/)
})

check('a cross-origin POST is refused', async () => {
  const reply = await request(hostFor(), {
    action: 'connection.status',
    headers: { origin: 'http://evil.example', host: '127.0.0.1:53109' },
  })
  assert.equal(reply.status, 403)
  assert.equal(reply.json.error.code, 'origin_mismatch')
})

check('a same-origin POST is accepted', async () => {
  const reply = await request(hostFor(), {
    action: 'task.target.get',
    body: { action: 'task.target.get', sessionId: 's1' },
    headers: { origin: 'http://127.0.0.1:53109', host: '127.0.0.1:53109' },
  })
  assert.equal(reply.status, 200)
  assert.equal(reply.json.ok, true)
  assert.equal(reply.json.target, 'local')
})

check('an oversized body is rejected before parsing', async () => {
  const reply = await request(hostFor(), {
    body: { action: 'task.target.get', sessionId: 'x'.repeat(1024 * 1024 + 10) },
  })
  assert.equal(reply.json.ok, false)
  assert.equal(reply.json.error.code, 'body_too_large')
})

check('unknown actions are refused on both verbs', async () => {
  const post = await request(hostFor(), { action: 'shell.exec' })
  assert.equal(post.json.error.code, 'unsupported_action')
  const get = await request(hostFor(), { method: 'GET', action: 'secrets' })
  assert.equal(get.json.error.code, 'unsupported_action')
})

check('the target toggle validates its inputs', async () => {
  const badTarget = await request(hostFor(), { action: 'task.target.set', body: { action: 'task.target.set', sessionId: 's1', target: 'both' } })
  assert.equal(badTarget.json.error.code, 'invalid_target')
  const badSession = await request(hostFor(), { action: 'task.target.set', body: { action: 'task.target.set', sessionId: '', target: 'cloud' } })
  assert.equal(badSession.json.error.code, 'invalid_session')
})

check('the token source is reported without the value', async () => {
  const reply = await request(hostFor(), { method: 'GET', action: 'overview' })
  assert.equal(reply.json.ok, true)
  const connection = reply.json.connection
  assert.equal(connection.configured, false)
  assert.equal(connection.tokenSource, null)
  assert.deepEqual(Object.keys(connection).sort(), [
    'autoToken',
    'baseUrl',
    'baseUrlSource',
    'configured',
    'dashboardUrl',
    'modelCredential',
    'tokenSource',
  ])
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
