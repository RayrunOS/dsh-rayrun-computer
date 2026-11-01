/**
 * Update checks for the Rayrun bundle.
 *
 * DSH has no updater for third-party bundles: a version change is an uninstall
 * followed by an install through the profile's plugin manager, and an open page
 * only learns about a newer version if the bundle itself asks a registry. This
 * module keeps that check and the two-step install free of Host context so it
 * can be tested without a running Harness.
 */

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/

/** The default registries to ask, in order. */
export const DEFAULT_REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com']

/** Parse a stable SemVer version into comparable numbers, or null for anything else. */
export function parseVersion(value) {
  const match = VERSION.exec(String(value ?? '').trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Whether `candidate` is a strictly newer stable release than `current`. */
export function isNewer(candidate, current) {
  const next = parseVersion(candidate)
  const now = parseVersion(current)
  if (!next || !now) return false
  for (let index = 0; index < next.length; index += 1) {
    if (next[index] !== now[index]) return next[index] > now[index]
  }
  return false
}

/**
 * Whether an installed dependency spec can be replaced by a registry version.
 * Profile-owned local links, files, tarballs and git specs cannot: reinstalling
 * them would point the profile somewhere else.
 */
export function canAutoUpdate(source, name) {
  return typeof source === 'string' && source.startsWith(`${name}@`)
}

/** Read the highest published version from the first registry that answers. */
export async function fetchLatestVersion(name, options = {}) {
  const fetchImpl = options.fetch ?? fetch
  const registries = options.registries ?? DEFAULT_REGISTRIES
  let failure
  for (const registry of registries) {
    const host = (() => {
      try {
        return new URL(registry).host
      } catch {
        return registry
      }
    })()
    try {
      const response = await fetchImpl(`${registry.replace(/\/+$/, '')}/${encodeURIComponent(name)}/latest`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      })
      if (!response.ok) throw new Error(`${host} responded ${response.status}`)
      const body = await response.json()
      if (parseVersion(body?.version) === null) throw new Error(`${host} returned no usable version`)
      return body.version
    } catch (error) {
      failure = error
    }
  }
  throw failure ?? new Error('No registry was asked.')
}

/**
 * Install `to` over the running bundle.
 *
 * With HMR the plugin manager refuses to install a package the profile already
 * depends on, so the old version is removed first; a failed install puts it
 * back, because removal already succeeded.
 */
export async function applyUpdate(manager, { name, from, to }) {
  try {
    await manager.removeBundle(name)
  } catch (error) {
    return { ok: false, code: 'remove_failed', message: String(error?.message ?? error), rolledBack: false }
  }
  let installed
  try {
    installed = await manager.installBundle(`${name}@${to}`, { enabled: true, saveExact: true })
  } catch (error) {
    installed = { application: 'failed', error: { message: String(error?.message ?? error) } }
  }
  if (installed?.application !== 'failed') {
    return {
      ok: true,
      application: installed?.application ?? 'applied',
      version: installed?.version ?? to,
      restartReason: installed?.restartReason,
    }
  }
  const message = installed?.error?.message ?? installed?.error?.code ?? 'installation failed'
  let rolledBack = false
  try {
    const restored = await manager.installBundle(`${name}@${from}`, { enabled: true, saveExact: true })
    rolledBack = restored?.application !== 'failed'
  } catch {
    rolledBack = false
  }
  return { ok: false, code: 'install_failed', message, rolledBack }
}
