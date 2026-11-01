/**
 * Cloud worker projection.
 *
 * Phase 0 established the shape of the cloud side: the Rayrun machine agent is a
 * DSH boot inside the guest (`dsh --profile headless`), its home is
 * `$DSH_HOME` (= /workspace/.rayrun/dsh), and `initProfile` never rewrites a
 * profile whose files already exist. So the local profile can push a layer into
 * `$DSH_HOME/profiles/headless` and the next agent run boots it.
 *
 * The projection has two parts:
 *  - a deterministic worker layer (`cordis.patch.yml`) plus provenance;
 *  - this plugin's own files, dropped at `<profile>/node_modules/dsh-rayrun-computer`.
 *    DSH resolves a profile bundle through ordinary Node resolution from the
 *    profile directory, so no tarball, registry access, or install step is needed
 *    on a machine whose egress is closed.
 *
 * The module never reads the local credential store and refuses to emit
 * anything that looks like a secret.
 */
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { LocalError } from './rayrun.js'

/** The profile Rayrun boots for the machine agent. */
export const CLOUD_PROFILE = 'headless'
/** The functional payload: the patch layer the cloud profile gains. */
export const LAYER_FILE = 'cordis.patch.yml'
/** Provenance for the synced projection; not read by DSH itself. */
export const MANIFEST_FILE = 'cloud-projection.json'

/**
 * Secret shapes that must never reach a cloud machine. The projection is
 * generated, so a hit means a bug or a template that embedded a credential.
 */
const SECRET_RULES = [
  { name: 'deepseek_key', pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
  { name: 'private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'secret_assignment', pattern: /\b[A-Za-z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*\S{12,}/ },
  { name: 'credential_store', pattern: /\.credentials\.yaml/ },
]

const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/
const SAFE_RELATIVE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

export function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Throw on the first secret-looking string in a projected file set. */
export function scanSecrets(files) {
  for (const [name, content] of Object.entries(files)) {
    const text = typeof content === 'string' ? content : content.toString('utf8')
    for (const rule of SECRET_RULES) {
      if (rule.pattern.test(text)) {
        throw new LocalError(
          'secret_detected',
          `Refusing to project ${name}: it matches the ${rule.name} secret rule. Remove the value and sync again.`,
        )
      }
    }
  }
}

/** Deterministic digest over name→content-hash pairs, independent of read order. */
export function revisionFromHashes(hashes) {
  const parts = Object.keys(hashes)
    .sort()
    .map((name) => `${name}\0${hashes[name]}`)
  return sha256(parts.join('\n'))
}

/** Deterministic digest of a file map, independent of read order and content type. */
export function filesRevision(files) {
  const hashes = {}
  for (const [name, content] of Object.entries(files)) {
    hashes[name] = createHash('sha256').update(content).digest('hex')
  }
  return revisionFromHashes(hashes)
}

/**
 * The plugin files a cloud worker needs. `client.js` is deliberately absent: a
 * headless profile serves no client bundle, so shipping it would only be bytes.
 */
export async function readPluginFiles(packageDir) {
  const files = {}
  for (const name of ['package.json', 'index.js', 'cordis.patch.yml']) {
    files[name] = await readFile(path.join(packageDir, name))
  }
  for (const name of await readdir(path.join(packageDir, 'lib'))) {
    if (name.endsWith('.js')) files[`lib/${name}`] = await readFile(path.join(packageDir, 'lib', name))
  }
  return files
}

/**
 * The worker layer. Deterministic by construction (no timestamps, no host paths)
 * so `status` can compare hashes across machines.
 *
 * `sandbox-policy` and `approval` are restated in full because a patch replaces a
 * row's config wholesale. Without the override the cloud agent asks for a
 * `workspace-write` sandbox backend the image does not ship (no bubblewrap, no
 * Landlock), and every shell call fails before it runs.
 *
 * When the plugin itself is projected, its bundle row gets `cloudMode: true`, so
 * the cloud agent does not try to manage machines that it cannot reach anyway.
 */
export function projectionLayer({ sourceProfile, plugin } = {}) {
  const source = String(sourceProfile ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '')
  const rows = [
    `# Written by dsh-rayrun-computer from the local "${source}" profile.`,
    '# Do not edit on the cloud: edit locally and run `rayrun_dsh sync` again.',
    '- id: sandbox-policy',
    "  name: '@deepseek-ai/dsh-sandbox-policy'",
    '  config:',
    '    mode: danger-full-access',
    '    workspaceRoot: !!js process.cwd()',
    '- id: approval',
    "  name: '@deepseek-ai/dsh-user-approval'",
    '  config:',
    '    policy: never',
  ]
  if (plugin?.name) {
    rows.push('- id: rayrun-cloud', `  name: '${plugin.name}'`, '  config:', '    cloudMode: true')
  }
  return `${rows.join('\n')}\n`
}

/** Hash of the local profile inputs the projection was built from, no secrets. */
async function sourceRevision(sourceDir) {
  if (!sourceDir) return null
  const parts = []
  for (const name of ['package.json', 'cordis.patch.yml']) {
    try {
      parts.push(`${name}\0${await readFile(path.join(sourceDir, name), 'utf8')}`)
    } catch {
      // a profile without one of them is still a valid source
    }
  }
  return parts.length ? sha256(parts.join('\0')) : null
}

/**
 * Build what a sync writes. `rev` covers the functional layer only, so a status
 * check is stable across runs; the plugin digest travels in the manifest.
 */
export async function exportProfileProjection({ sourceProfile, sourceDir, plugin, pluginFiles } = {}) {
  const layer = projectionLayer({ sourceProfile, plugin })
  const rev = sha256(layer)
  const pluginRev = pluginFiles ? filesRevision(pluginFiles) : null
  const manifest = {
    kind: 'dsh-rayrun-cloud-projection',
    version: 2,
    profile: CLOUD_PROFILE,
    sourceProfile: sourceProfile ?? null,
    sourceRev: await sourceRevision(sourceDir),
    generatedAt: new Date().toISOString(),
    plugin: plugin ? { ...plugin, rev: pluginRev } : null,
    files: { [LAYER_FILE]: rev },
    rev,
    capabilities: {
      shell: 'danger-full-access',
      approval: 'never',
      cloudMode: Boolean(plugin),
    },
  }
  scanSecrets({ [LAYER_FILE]: layer })
  if (pluginFiles) scanSecrets(pluginFiles)
  const files = {
    [LAYER_FILE]: layer,
    [MANIFEST_FILE]: `${JSON.stringify(manifest, null, 2)}\n`,
  }
  return {
    files,
    plugin: plugin ? { ...plugin, rev: pluginRev } : null,
    pluginFiles: pluginFiles ? { ...pluginFiles } : null,
    manifest,
    rev,
    pluginRev,
  }
}

/** Run a POSIX command in the machine and return its stdout. */
async function shell(ray, machineId, command, options = {}) {
  const result = await ray.exec(
    machineId,
    { command, timeout_seconds: Math.min(Number(options.timeoutSeconds ?? 60), 3600) },
    { timeoutMs: (Number(options.timeoutSeconds ?? 60) + 30) * 1000, signal: options.signal },
  )
  return {
    stdout: String(result?.stdout ?? ''),
    stderr: String(result?.stderr ?? ''),
    exitCode: result?.exit_code ?? null,
  }
}

/** Where the guest keeps its DSH home and the profile Rayrun boots. */
export async function cloudWorkerPaths(ray, machineId, options = {}) {
  // One value per line, no `$(...)`: some guest agents truncate a command at the
  // first command substitution, which silently dropped everything after it.
  const out = await shell(ray, machineId, 'printf "%s\\n" "${DSH_HOME:-}" "${HOME:-}"\npwd', {
    ...options,
    timeoutSeconds: 30,
  })
  const [dshHome = '', home = '', root = ''] = out.stdout.trimEnd().split('\n')
  const resolvedHome = (dshHome || (home ? `${home}/.dsh` : '')).trim()
  if (!SAFE_PATH.test(resolvedHome)) {
    throw new LocalError('cloud_home_unresolved', `The machine reported an unusable DSH home: ${JSON.stringify(resolvedHome)}`)
  }
  const workspace = root.trim()
  const dir = `${resolvedHome}/profiles/${CLOUD_PROFILE}`
  // The files API addresses the machine workspace, so a DSH home outside it
  // cannot be uploaded into; say so instead of writing to a guessed path.
  if (!workspace || !SAFE_PATH.test(workspace) || !dir.startsWith(`${workspace}/`)) {
    throw new LocalError(
      'cloud_home_not_uploadable',
      `The cloud DSH home ${resolvedHome} is outside the machine workspace ${workspace || '(unknown)'}; only workspace-backed DSH homes can be projected.`,
    )
  }
  return { home: resolvedHome, dir, relDir: dir.slice(workspace.length + 1) }
}

/** Where the projected plugin lives inside the cloud profile. */
export function cloudPluginDir(profileDir, pluginName) {
  return `${profileDir}/node_modules/${String(pluginName)}`
}

function sha256Lines(files, prefix) {
  return Object.keys(files)
    .sort()
    .map((name) => `${prefix}/${name}`)
    .join(' ')
}

/** Version facts, layer state, and the projected plugin's presence. */
export async function cloudWorkerFacts(ray, machineId, paths, projection, options = {}) {
  const pluginName = projection.plugin?.name
  const sections = [
    `d="${paths.dir}"`,
    'echo "--layer--"',
    'sha256sum "$d/cordis.patch.yml" "$d/cloud-projection.json" 2>/dev/null',
    'echo "--plugin--"',
  ]
  if (projection.pluginFiles && pluginName) {
    const pluginDir = cloudPluginDir(paths.dir, pluginName)
    sections.push(`sha256sum ${sha256Lines(projection.pluginFiles, pluginDir)} 2>/dev/null`)
  }
  sections.push(
    'echo "--bundles--"',
    'node -e "const p=require(process.argv[1]);console.log((p.dsh&&p.dsh.profile&&p.dsh.profile.bundles||[]).join(\',\'))" "$d/package.json" 2>/dev/null',
    'echo "--row--"',
    'dsh --profile ' + CLOUD_PROFILE + ' --dump-config 2>/dev/null | grep -c "cloudMode: true" || true',
    'echo "--versions--"',
    'dsh --version 2>&1 | head -1',
    'node --version 2>&1 | head -1',
  )
  const out = await shell(ray, machineId, sections.join('\n'), { ...options, timeoutSeconds: 120 })
  const text = out.stdout
  const section = (name) => {
    const start = text.indexOf(`--${name}--`)
    if (start === -1) return ''
    const rest = text.slice(start + name.length + 4)
    const end = rest.search(/\n--[a-z]+--\n/)
    return end === -1 ? rest : rest.slice(0, end + 1)
  }
  const hashes = (block) => {
    const map = {}
    for (const line of block.split('\n')) {
      const match = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim())
      if (!match) continue
      map[match[2]] = match[1]
    }
    return map
  }
  const layerHashes = hashes(section('layer'))
  const pluginHashes = hashes(section('plugin'))
  const pluginRevs = {}
  for (const [name, hash] of Object.entries(pluginHashes)) {
    const prefix = pluginName ? `${cloudPluginDir(paths.dir, pluginName)}/` : ''
    pluginRevs[prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name] = hash
  }
  const versions = section('versions')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return {
    layerRev: layerHashes[`${paths.dir}/${LAYER_FILE}`] ?? null,
    pluginFiles: pluginRevs,
    pluginPresent: Object.keys(pluginRevs).length > 0,
    bundles: section('bundles').trim().split(',').filter(Boolean),
    cloudModeRows: Number(section('row').trim().split('\n').pop() || 0),
    dsh: versions.find((line) => !line.startsWith('v')) ?? null,
    node: versions.find((line) => line.startsWith('v')) ?? null,
  }
}

/** Merge this plugin into the cloud profile's bundle list, writing only on change. */
async function ensureBundle(ray, machineId, paths, pluginName, options) {
  if (!paths.relDir) {
    throw new LocalError('cloud_home_not_uploadable', 'The cloud profile is not inside the machine workspace; it cannot be projected.')
  }
  const current = await shell(ray, machineId, `cat "${paths.dir}/package.json" 2>/dev/null`, {
    ...options,
    timeoutSeconds: 30,
  })
  let manifest
  try {
    manifest = JSON.parse(current.stdout)
  } catch {
    throw new LocalError('cloud_profile_unreadable', `The cloud profile manifest at ${paths.dir}/package.json is not valid JSON.`)
  }
  const profile = manifest?.dsh?.profile
  const bundles = Array.isArray(profile?.bundles) ? [...profile.bundles] : []
  if (bundles.includes(pluginName)) return false
  const next = {
    ...manifest,
    dsh: { ...manifest.dsh, profile: { ...profile, bundles: [...bundles, pluginName] } },
  }
  await uploadFileTo(ray, paths, 'package.json', Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8'), options)
  return true
}

async function uploadFileTo(ray, paths, relative, content, options) {
  if (!SAFE_RELATIVE.test(relative)) {
    throw new LocalError('invalid_projection_path', `Refusing to write an unexpected path: ${JSON.stringify(relative)}`)
  }
  return ray.uploadFile(paths.machineId, `${paths.relDir}/${relative}`, content, options?.signal)
}

/**
 * Write the projection into the cloud profile. Backs the profile up once, so a
 * bad projection can be rolled back by hand, and verifies the result instead of
 * assuming the upload landed.
 */
export async function syncCloudWorker(ray, machine, projection, options = {}) {
  const resolved = await cloudWorkerPaths(ray, machine.id, options)
  const paths = { ...resolved, machineId: machine.id }
  const pluginName = projection.plugin?.name
  const backup = await shell(
    ray,
    machine.id,
    [
      `d="${paths.dir}"`,
      'mkdir -p "$d"',
      // A fresh machine has no profile until DSH initializes one from its
      // template; do that first so the backup and the merge see a real manifest.
      'if [ ! -f "$d/package.json" ]; then dsh --profile ' + CLOUD_PROFILE + ' --dump-config >/dev/null 2>&1 || true; fi',
      'if [ ! -e "$d.pre-projection" ]; then cp -a "$d" "$d.pre-projection" && echo created; else echo kept; fi',
    ].join('\n'),
    { ...options, timeoutSeconds: 120 },
  )
  let bundleAdded = false
  if (pluginName) bundleAdded = await ensureBundle(ray, machine.id, paths, pluginName, options)
  for (const [name, content] of Object.entries(projection.files)) {
    await uploadFileTo(ray, paths, name, Buffer.from(content, 'utf8'), options)
  }
  if (projection.pluginFiles && pluginName) {
    const pluginDir = `node_modules/${pluginName}`
    await shell(ray, machine.id, `mkdir -p "${cloudPluginDir(paths.dir, pluginName)}"`, {
      ...options,
      timeoutSeconds: 30,
    })
    for (const [name, content] of Object.entries(projection.pluginFiles)) {
      await uploadFileTo(ray, paths, `${pluginDir}/${name}`, content, options)
    }
  }
  const facts = await cloudWorkerFacts(ray, machine.id, paths, projection, options)
  const remotePluginRev = facts.pluginPresent ? revisionFromHashes(facts.pluginFiles) : null
  return {
    machine: { id: machine.id, name: machine.name ?? null },
    profile: paths,
    rev: projection.rev,
    remoteRev: facts.layerRev,
    synced: facts.layerRev === projection.rev,
    plugin: pluginName
      ? {
          name: pluginName,
          rev: projection.pluginRev,
          remoteRev: remotePluginRev,
          synced: remotePluginRev === projection.pluginRev,
        }
      : null,
    bundleAdded,
    uploaded: Object.keys(projection.files),
    backup: backup.stdout.trim() === 'created' ? 'created' : 'kept',
    dsh: facts.dsh,
    node: facts.node,
    layerRows: facts.cloudModeRows,
    bundles: facts.bundles,
    manifest: projection.manifest,
  }
}

/** Read the cloud worker state without changing it. */
export async function readCloudWorker(ray, machine, projection, options = {}) {
  const paths = { ...(await cloudWorkerPaths(ray, machine.id, options)), machineId: machine.id }
  const facts = await cloudWorkerFacts(ray, machine.id, paths, projection, options)
  let manifest = null
  const out = await shell(ray, machine.id, `cat "${paths.dir}/${MANIFEST_FILE}" 2>/dev/null`, {
    ...options,
    timeoutSeconds: 30,
  })
  try {
    manifest = out.stdout.trim() ? JSON.parse(out.stdout) : null
  } catch {
    manifest = null
  }
  return {
    machine: { id: machine.id, name: machine.name ?? null },
    profile: paths,
    remoteRev: facts.layerRev,
    plugin: projection.plugin?.name
      ? {
          name: projection.plugin.name,
          remoteRev: facts.pluginPresent ? revisionFromHashes(facts.pluginFiles) : null,
        }
      : null,
    bundles: facts.bundles,
    manifest,
    dsh: facts.dsh,
    node: facts.node,
    layerRows: facts.cloudModeRows,
  }
}
