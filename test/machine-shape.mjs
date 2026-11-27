/**
 * shapeSandbox must keep the credential binding names attached to a sandbox.
 * A runtime spec without explicit credentials uses these names, so dropping
 * them makes the cloud DSH exit with MISSING_CREDENTIAL.
 *
 *   node test/machine-shape.mjs
 */
import assert from 'node:assert/strict'
import { shapeSandbox } from '../lib/rayrun.js'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

check('keeps the credential binding names from the API', () => {
  const machine = shapeSandbox({ id: 'sb-test', credentials: ['model-a', 'model-b'] })
  assert.deepEqual(machine.credentials, ['model-a', 'model-b'])
})

check('defaults to an empty list when the API has none', () => {
  assert.deepEqual(shapeSandbox({ id: 'sb-test' }).credentials, [])
  assert.deepEqual(shapeSandbox({ id: 'sb-test', credentials: null }).credentials, [])
  assert.deepEqual(shapeSandbox({ id: 'sb-test', credentials: 'model-a' }).credentials, [])
})

check('drops empty and non-string entries', () => {
  const machine = shapeSandbox({ id: 'sb-test', credentials: ['model-a', '', null, { name: 'model-b' }] })
  assert.deepEqual(machine.credentials, ['model-a'])
})

console.log(`\n${passed} machine-shape checks passed`)
