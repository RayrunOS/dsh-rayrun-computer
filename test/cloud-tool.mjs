/**
 * Registration-level checks for the `rayrun_dsh` tool, driven through the real
 * `apply` export with a fake Harness context. No Rayrun API is touched: the
 * invalid-action path is rejected before any machine is resolved.
 *
 *   node test/cloud-tool.mjs
 */
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const tools = []
const store = { resolve: async () => undefined, set: async () => {}, unset: async () => {} }

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
  get(name) {
    if (name === 'credentials') return store
    if (name === 'profileContext') return { name: 'desktop', dir: null }
    return undefined
  },
  tools: {
    register(tool) {
      tools.push(tool)
    },
    guard() {
      return () => {}
    },
  },
}

apply(ctx, {})

const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('registers the four machine tools plus rayrun_dsh and rayrun_workspace', () => {
  const names = tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, ['rayrun_agent', 'rayrun_dsh', 'rayrun_exec', 'rayrun_files', 'rayrun_sandbox', 'rayrun_workspace'])
})

check('rayrun_workspace exposes push and pull only', () => {
  const tool = tools.find((item) => item.name === 'rayrun_workspace')
  assert.ok(tool, 'rayrun_workspace is registered')
  assert.deepEqual(tool.parameters.properties.action.enum, ['push', 'pull'])
  assert.deepEqual(tool.parameters.required, ['action'])
  assert.match(tool.description, /applies nothing/)
})

check('rayrun_dsh exposes sync, status and delegate, with an optional machine', () => {
  const tool = tools.find((item) => item.name === 'rayrun_dsh')
  assert.ok(tool, 'rayrun_dsh is registered')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.properties.action.enum, ['sync', 'status', 'delegate'])
  assert.deepEqual(tool.parameters.required, ['action'])
  assert.equal(tool.parameters.properties.sandbox.type, 'string')
  for (const field of ['objective', 'acceptance', 'constraints', 'decisions', 'open_questions', 'context', 'task_id']) {
    assert.ok(tool.parameters.properties[field], `delegate accepts ${field}`)
  }
  assert.match(tool.description, /DSH worker layer/)
  assert.match(tool.description, /delegate/)
  assert.equal(tool.output.render(undefined, 'one line')[0].text, 'one line')
})

check('an unknown action is rejected before any machine is resolved', async () => {
  const tool = tools.find((item) => item.name === 'rayrun_dsh')
  await assert.rejects(
    () => tool.execute({ action: 'deploy' }, { signal: undefined }),
    (error) => /Unknown action; use "sync", "status" or "delegate"/.test(String(error?.message)),
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
if (failed) process.exitCode = 1
