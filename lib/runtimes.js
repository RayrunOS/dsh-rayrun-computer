/**
 * Runtime spec validation and shaping for the host-callable runtime RPC.
 *
 * The platform (ADR-036) owns the authoritative limits and error codes; this
 * module only rejects caller-shape mistakes before a network call and builds
 * the exact PUT body. `credentials` are binding names attached to the sandbox:
 * values never enter this module or the request body.
 */
import { LocalError } from './rayrun.js'

/** Sandbox runtime names: the same shape the platform accepts. */
export const RUNTIME_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

const RESTART = new Set(['no', 'on-failure', 'always'])
const STOP_SIGNALS = new Set(['SIGTERM', 'SIGINT', 'SIGKILL'])
const SPEC_FIELDS = new Set([
  'argv',
  'workdir',
  'env',
  'credentials',
  'restart',
  'autostart',
  'keep_alive',
  'stop_signal',
  'stop_timeout_seconds',
])

const invalid = (message) => new LocalError('invalid_runtime_spec', message)

export function runtimeName(value) {
  const name = String(value ?? '').trim()
  if (!RUNTIME_NAME.test(name)) {
    throw new LocalError('invalid_runtime_name', '`name` must match [a-z0-9][a-z0-9-]{0,63}.')
  }
  return name
}

/**
 * Normalize the caller's spec into the platform PUT body.
 *
 * Unknown fields are refused rather than dropped, so a typo or a smuggled
 * secret cannot silently disappear. Omitted fields stay omitted: the platform
 * distinguishes an omitted `autostart` (default true) from an explicit false.
 */
export function runtimeSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('`spec` must be an object.')
  }
  const unknown = Object.keys(value).filter((key) => !SPEC_FIELDS.has(key))
  if (unknown.length) {
    throw invalid(`Unknown spec field(s): ${unknown.join(', ')}.`)
  }
  if (!Array.isArray(value.argv) || value.argv.length === 0) {
    throw invalid('`spec.argv` must be a non-empty array of strings.')
  }
  const argv = value.argv.map((item) => {
    if (typeof item !== 'string' || item === '') {
      throw invalid('`spec.argv` must contain non-empty strings.')
    }
    return item
  })
  const spec = { argv }

  if (value.workdir !== undefined) {
    if (typeof value.workdir !== 'string') throw invalid('`spec.workdir` must be a string.')
    spec.workdir = value.workdir
  }
  if (value.env !== undefined) {
    if (!value.env || typeof value.env !== 'object' || Array.isArray(value.env)) {
      throw invalid('`spec.env` must be an object of string values.')
    }
    const env = {}
    for (const [key, item] of Object.entries(value.env)) {
      if (typeof item !== 'string') throw invalid(`\`spec.env.${key}\` must be a string.`)
      env[key] = item
    }
    spec.env = env
  }
  if (value.credentials !== undefined) {
    if (
      !Array.isArray(value.credentials) ||
      value.credentials.some((item) => typeof item !== 'string' || item === '')
    ) {
      throw invalid('`spec.credentials` must be an array of binding names, never values.')
    }
    spec.credentials = [...value.credentials]
  }
  if (value.restart !== undefined) {
    if (!RESTART.has(value.restart)) throw invalid('`spec.restart` must be no, on-failure or always.')
    spec.restart = value.restart
  }
  if (value.autostart !== undefined) {
    if (typeof value.autostart !== 'boolean') throw invalid('`spec.autostart` must be a boolean.')
    spec.autostart = value.autostart
  }
  if (value.keep_alive !== undefined) {
    if (typeof value.keep_alive !== 'boolean') throw invalid('`spec.keep_alive` must be a boolean.')
    spec.keep_alive = value.keep_alive
  }
  if (value.stop_signal !== undefined) {
    if (!STOP_SIGNALS.has(value.stop_signal)) {
      throw invalid('`spec.stop_signal` must be SIGTERM, SIGINT or SIGKILL.')
    }
    spec.stop_signal = value.stop_signal
  }
  if (value.stop_timeout_seconds !== undefined) {
    if (
      !Number.isInteger(value.stop_timeout_seconds) ||
      value.stop_timeout_seconds < 0 ||
      value.stop_timeout_seconds > 30
    ) {
      throw invalid('`spec.stop_timeout_seconds` must be an integer from 0 to 30.')
    }
    spec.stop_timeout_seconds = value.stop_timeout_seconds
  }
  return spec
}
