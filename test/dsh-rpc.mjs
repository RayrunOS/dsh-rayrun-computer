/**
 * Contract checks for the host-callable detached worker surface:
 * `dsh.start`, `dsh.status` and `dsh.result` on `/plugins/rayrun/rpc`.
 *
 * Drives the real handler through a fake Rayrun API and a real temporary git
 * checkout, so the same-origin gate, the explicit-machine rule, start → status
 * → result, and result collection are tested where they actually run.
 *
 *   node test/dsh-rpc.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'
import { exportProfileProjection, readPluginFiles } from '../lib/cloud-dsh.js'
import { EMPTY_DIGEST } from '../lib/workspace-lock.js'

const NAME = 'dsh-rayrun-computer'
const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url))
const VERSION = JSON.parse(readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8')).version
const realFetch = globalThis.fetch

// Keep the plugin's update check off the network; everything else (the fake
// Rayrun server) still goes through the real fetch.
globalThis.fetch = async (url, init) => {
  if (String(url).includes(`${NAME}/latest`)) return { ok: false, status: 404, json: async () => ({}) }
  return realFetch(url, init)
}

delete process.env.RAYRUN_TOKEN

const projection = await exportProfileProjection({
  sourceProfile: 'test',
  sourceDir: null,
  plugin: { name: NAME, version: VERSION },
  pluginFiles: await readPluginFiles(PACKAGE_DIR),
})

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

/** The fake guest: one running machine, a workspace, and a result file. */
const cloud = {
  machines: [
    {
      id: 'sb-test-0001',
      name: 'box',
      agent: 'deepseek-harness@1',
      status: 'Running',
      cpu_cores: 2,
      memory_mb: 2048,
      workspace_mb: 10240,
      remote_desktop: false,
    },
  ],
  files: new Map(),
  requests: [],
  prompts: [],
  running: true,
  resultFiles: ['result.txt'],
}

/** Exec answers for the commands the delegation path runs. */
function execResult(command) {
  const stdout = (text) => ({ exit_code: 0, stdout: text })
  if (command.includes('printf "running=')) {
    return stdout(
      [
        `running=${cloud.running ? 1 : 0}`,
        'activity=2026-11-22 10:00:00.000000000 +0000',
        ...cloud.resultFiles.map((name) => `file=${name}`),
        '',
      ].join('\n'),
    )
  }
  if (command.includes('ls -1 .dsh/results')) return stdout(`${cloud.resultFiles.join('\n')}\n`)
  if (command.includes('--head--')) {
    // A fresh workspace prints nothing for `git rev-parse HEAD`, so the next
    // marker follows with no blank line; this also covers the empty-head parse.
    return stdout(`--head--\n--digest--\n${EMPTY_DIGEST}\n--status--\n0\n--state--\n`)
  }
  if (command.startsWith('printf "%s\\n"')) return stdout('/workspace/.rayrun/dsh\n/root\n/workspace\n')
  if (command.includes('--layer--')) return stdout(facts())
  if (command.includes('cloud-projection.json')) return stdout('')
  if (command.includes('echo prepared')) return stdout('prepared\n')
  if (command.includes('git fetch -q --no-tags')) return stdout(`${cloud.head}\n`)
  if (command.includes('cloud-dirty.patch')) return stdout(`${cloud.head}\n${EMPTY_DIGEST}\n0\n`)
  if (command.trim() === 'pwd') return stdout('/workspace\n')
  if (command.includes('mkdir -p .dsh/results')) return stdout('')
  return stdout('')
}

function facts() {
  const dir = '/workspace/.rayrun/dsh/profiles/headless'
  const lines = [
    '--layer--',
    `${projection.rev}  ${dir}/cordis.patch.yml`,
    `${sha256(projection.files['cloud-projection.json'])}  ${dir}/cloud-projection.json`,
    '--plugin--',
  ]
  for (const [file, content] of Object.entries(projection.pluginFiles ?? {})) {
    lines.push(`${sha256(content)}  ${dir}/node_modules/${NAME}/${file}`)
  }
  lines.push('--bundles--', '', '--row--', '0', '--versions--', '0.2.2-rc.5', 'v22.0.0')
  return `${lines.join('\n')}\n`
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
  cloud.requests.push({ method: req.method, path: url.pathname, headers: req.headers })
  if (req.headers.authorization !== 'Bearer test-token') {
    json(res, 401, { error: 'unauthorized' })
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
  if (req.method === 'POST' && /^\/v1\/sandboxes\/[^/]+\/exec$/.test(url.pathname)) {
    json(res, 200, execResult(String(JSON.parse(raw).command ?? '')))
    return
  }
  if (req.method === 'POST' && /^\/v1\/sandboxes\/[^/]+\/prompts$/.test(url.pathname)) {
    cloud.prompts.push(JSON.parse(raw))
    json(res, 200, { prompt_id: 'prompt-1' })
    return
  }
  const file = /^\/v1\/sandboxes\/[^/]+\/files\/(.+)$/.exec(url.pathname)
  if (file) {
    const key = file[1].split('/').map((part) => decodeURIComponent(part)).join('/')
    if (req.method === 'PUT') {
      cloud.files.set(key, raw)
      json(res, 200, { ok: true })
      return
    }
    if (req.method === 'GET') {
      const body = key.endsWith('/result.txt') ? Buffer.from('done\n', 'utf8') : cloud.files.get(key)
      if (!body) {
        json(res, 404, { error: 'not_found' })
        return
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(body)
      return
    }
  }
  json(res, 404, { error: 'not_found' })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`

const repo = await mkdtemp(path.join(tmpdir(), 'dsh-rpc-test-'))
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString()
git('init', '-q')
git('config', 'user.email', 'test@example.invalid')
git('config', 'user.name', 'Test')
await writeFile(path.join(repo, '.gitignore'), '.dsh/\n')
await writeFile(path.join(repo, 'README.md'), '# test\n')
git('add', '.')
git('commit', '-qm', 'init')
cloud.head = git('rev-parse', 'HEAD').trim()

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
      // localProfile() only accepts a non-empty dir; this one has no DSH
      // manifest, so sourceRev stays null and matches the projection above.
      if (name === 'profileContext') return { name: 'test', dir: repo }
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

async function rpc(handler, body, { origin = 'http://127.0.0.1:53109', host = '127.0.0.1:53109' } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.url = '/plugins/rayrun'
  req.headers = { origin, host }
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
const noToken = hostFor({ token_file: path.join(tmpdir(), `dsh-rpc-${process.pid}-absent.token`) })
const startBody = (extra = {}) => ({
  action: 'dsh.start',
  sandbox: 'box',
  local_dir: repo,
  objective: 'write the result file',
  acceptance: ['result.txt exists'],
  ...extra,
})

try {
  check('a cross-origin dsh.start is refused before anything runs', async () => {
    const before = cloud.requests.length
    const reply = await rpc(host, startBody(), { origin: 'http://evil.example' })
    assert.equal(reply.status, 403)
    assert.equal(reply.json.error.code, 'origin_mismatch')
    assert.equal(cloud.requests.length, before, 'no Rayrun request was made')
  })

  check('without a Rayrun token dsh.start fails with token_required', async () => {
    const before = cloud.requests.length
    const reply = await rpc(noToken, startBody())
    assert.equal(reply.json.ok, false)
    assert.equal(reply.json.error.code, 'token_required')
    assert.equal(cloud.requests.length, before, 'no Rayrun request was made')
  })

  check('an explicit missing sandbox is sandbox_missing and never creates one', async () => {
    const before = cloud.requests.length
    const reply = await rpc(host, startBody({ sandbox: 'no-such-box' }))
    assert.equal(reply.json.ok, false)
    assert.equal(reply.json.error.code, 'sandbox_missing')
    const creates = cloud.requests
      .slice(before)
      .filter((item) => item.method === 'POST' && item.path === '/v1/sandboxes')
    assert.deepEqual(creates, [], 'the surface must not POST a new sandbox')
  })

  check('inputs are validated before a machine is touched', async () => {
    const missingSandbox = await rpc(host, { ...startBody(), sandbox: '' })
    assert.equal(missingSandbox.json.error.code, 'sandbox_required')
    const relative = await rpc(host, startBody({ local_dir: 'relative/path' }))
    assert.equal(relative.json.error.code, 'local_dir_not_absolute')
    const missingDir = await rpc(host, startBody({ local_dir: path.join(repo, 'absent') }))
    assert.equal(missingDir.json.error.code, 'local_dir_missing')
    const missingBrief = await rpc(host, startBody({ acceptance: [] }))
    assert.equal(missingBrief.json.error.code, 'brief_incomplete')
    const badTimeout = await rpc(host, startBody({ timeout: 0 }))
    assert.equal(badTimeout.json.error.code, 'invalid_timeout')
    const missingTask = await rpc(host, { action: 'dsh.status', sandbox: 'box' })
    assert.equal(missingTask.json.error.code, 'invalid_task_id')
    assert.equal(cloud.prompts.length, 0, 'no prompt was posted')
  })

  let taskId = ''

  check('start returns a task id without streaming and uploads the handoff', async () => {
    const started = await rpc(host, startBody({ task_id: 'task-dsh-rpc', context: 'carry this note', timeout: 120 }))
    assert.equal(started.json.ok, true, JSON.stringify(started.json))
    taskId = started.json.task_id
    assert.equal(taskId, 'task-dsh-rpc', 'a caller-supplied id is kept')
    assert.equal(started.json.round, 1, 'a fresh explicit id starts at round 1')
    assert.equal(started.json.sandbox, 'box')
    assert.equal(started.json.machine_id, 'sb-test-0001')
    assert.equal(started.json.prompt_id, 'prompt-1')
    assert.equal(started.json.results_dir, path.join(repo, '.dsh/results', taskId))
    assert.equal(cloud.prompts.length, 1)
    assert.match(cloud.prompts[0].text, new RegExp(`round-1`))
    const handoff = cloud.files.get(`.dsh/handoff/${taskId}/round-1/handoff.md`).toString('utf8')
    assert.match(handoff, /write the result file/)
    const conversation = cloud.files.get(`.dsh/handoff/${taskId}/round-1/conversation.md`).toString('utf8')
    assert.match(conversation, /carry this note/)
    assert.equal(cloud.requests.filter((item) => item.path.endsWith('/events')).length, 0, 'start must not stream')
    assert.doesNotMatch(started.text, /test-token|Bearer/)
  })

  check('status probes the task without downloading anything', async () => {
    const downloadedBefore = cloud.requests.filter((item) => item.method === 'GET' && item.path.includes('/files/')).length
    const status = await rpc(host, { action: 'dsh.status', sandbox: 'box', task_id: taskId })
    assert.equal(status.json.ok, true)
    assert.equal(status.json.task_id, taskId)
    assert.equal(status.json.running, true)
    assert.deepEqual(status.json.files, ['result.txt'])
    assert.match(status.json.activity, /^2026-11-22/)
    assert.equal(status.json.lock.holder, `delegate ${taskId}`)
    const downloadedAfter = cloud.requests.filter((item) => item.method === 'GET' && item.path.includes('/files/')).length
    assert.equal(downloadedAfter, downloadedBefore, 'status must not download result files')
    assert.doesNotMatch(status.text, /test-token|Bearer/)
  })

  check('result collects files, keeps the lock while running, and releases it later', async () => {
    const early = await rpc(host, { action: 'dsh.result', sandbox: 'box', task_id: taskId, local_dir: repo })
    assert.equal(early.json.ok, true)
    assert.equal(early.json.task_id, taskId)
    assert.equal(early.json.running, true)
    assert.deepEqual(early.json.files, ['result.txt'])
    assert.equal(early.json.results_dir, path.join(repo, '.dsh/results', taskId))
    assert.equal(early.json.released, false)
    assert.equal(await readFile(path.join(repo, '.dsh/results', taskId, 'result.txt'), 'utf8'), 'done\n')
    assert.doesNotMatch(early.text, /test-token|Bearer/)

    cloud.running = false
    const late = await rpc(host, { action: 'dsh.result', sandbox: 'box', task_id: taskId, local_dir: repo })
    assert.equal(late.json.ok, true)
    assert.equal(late.json.running, false)
    assert.equal(late.json.released, true)
    assert.deepEqual(late.json.files, ['result.txt'])
    cloud.running = true
  })

  check('start with task_id continues the same task at the next round', async () => {
    const second = await rpc(host, startBody({ task_id: taskId, objective: 'continue it' }))
    assert.equal(second.json.ok, true)
    assert.equal(second.json.task_id, taskId)
    assert.equal(second.json.round, 2)
    assert.match(cloud.prompts.at(-1).text, /round-2/)
    const handoff = cloud.files.get(`.dsh/handoff/${taskId}/round-2/handoff.md`).toString('utf8')
    assert.match(handoff, /continue it/)
  })

  check('no request ever created a sandbox', () => {
    const creates = cloud.requests.filter((item) => item.method === 'POST' && item.path === '/v1/sandboxes')
    assert.deepEqual(creates, [])
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
  await rm(repo, { recursive: true, force: true })
}
