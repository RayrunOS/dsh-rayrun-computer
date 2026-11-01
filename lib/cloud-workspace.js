/**
 * Workspace projection between the local checkout and a cloud machine.
 *
 * The plan's rule is local authority: pushing mirrors the local repo into the
 * cloud workspace, and pulling brings the cloud's changes back as a reviewable
 * artifact. Nothing here applies a cloud change to the local tree.
 *
 * Transport:
 *  - `git bundle --all` carries the commits, so the cloud ends up on the exact
 *    same HEAD (hashes are not rewritten the way a tar snapshot would);
 *  - `git diff --binary HEAD` carries the dirty tracked changes verbatim;
 *  - untracked files are uploaded one by one.
 * Both sides then regenerate the dirty patch and compare SHA-256, so a "pushed"
 * answer is a measured fact rather than an assumption.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { decidePush, EMPTY_DIGEST, pushedState } from './workspace-lock.js'
import { LocalError } from './rayrun.js'

const MAX_PATCH_BYTES = 16 * 1024 * 1024
const MAX_UNTRACKED_FILES = 200
const MAX_UNTRACKED_BYTES = 32 * 1024 * 1024
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024
const SYNC_DIR = '.dsh/sync'
const OUTGOING_DIR = '.dsh/outgoing'
const SAFE_PATH = /^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/

/** Paths the cloud workspace owns; they must never be cleaned or pushed. */
const CLOUD_OWNED = ['.rayrun/', '.dsh/', 'lost+found/']

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** Digest of a dirty patch; empty and missing patches hash the same. */
export function diffDigest(buffer) {
  return sha256Bytes(Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ''), 'utf8'))
}

/** Reject a path that would escape the workspace or need quoting in a command. */
export function assertSafeRelative(value) {
  const text = String(value ?? '').replace(/\\/g, '/')
  if (!text || text.startsWith('/') || text.split('/').includes('..') || /[\0\r\n]/.test(text)) {
    throw new LocalError('unsafe_path', `Refusing to sync an unsafe path: ${JSON.stringify(value)}`)
  }
  if (/['"`$;&|<>(){}*?[\]!#~\\]/.test(text)) {
    throw new LocalError('unsafe_path', `Refusing to sync a path with shell characters: ${JSON.stringify(value)}`)
  }
  if (text === '.git' || text.startsWith('.git/')) {
    throw new LocalError('unsafe_path', `Refusing to sync a git internal path: ${JSON.stringify(value)}`)
  }
  return text
}

/**
 * Parse `git status --porcelain -z`. Entries are NUL separated; a rename entry
 * carries the original path as one more NUL field.
 */
export function parsePorcelain(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer ?? '')
  const fields = text.split('\0').filter((field) => field.length > 0)
  const changes = []
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index]
    const code = entry.slice(0, 2)
    const file = entry.slice(3)
    if (code.startsWith('R') || code.startsWith('C')) index += 1
    changes.push({ code: code.trim() || '??', path: file })
  }
  return {
    changes,
    untracked: changes.filter((change) => change.code === '??').map((change) => change.path),
    dirty: changes.filter((change) => change.code !== '??').map((change) => change.path),
  }
}

/** Count the files a unified diff touches. */
export function diffFileCount(text) {
  return new Set(
    String(text ?? '')
      .split('\n')
      .filter((line) => line.startsWith('diff --git '))
      .map((line) => line.slice(line.indexOf(' b/') + 3)),
  ).size
}

/**
 * Run git without a shell, so paths and patches never pass through quoting.
 * Output goes through temporary files rather than pipes: a confined host can
 * refuse piped stdio (`spawn EPERM`), and a large patch would risk a pipe stall.
 */
async function runGit(cwd, args, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rayrun-git-'))
  const stdoutPath = path.join(dir, 'stdout')
  const stderrPath = path.join(dir, 'stderr')
  try {
    const stdoutFd = await open(stdoutPath, 'w')
    const stderrFd = await open(stderrPath, 'w')
    try {
      const exitCode = await new Promise((resolve, reject) => {
        const child = spawn('git', ['-c', 'core.quotepath=false', ...args], {
          cwd,
          windowsHide: true,
          stdio: ['ignore', stdoutFd.fd, stderrFd.fd],
        })
        child.on('error', () => reject(new LocalError('git_missing', 'git is not available on this machine.')))
        child.on('close', (code) => resolve(code ?? 1))
        options.signal?.addEventListener('abort', () => child.kill(), { once: true })
      })
      const stdout = await readFile(stdoutPath)
      const stderr = (await readFile(stderrPath)).toString('utf8')
      if (stdout.length > (options.maxBytes ?? MAX_PATCH_BYTES)) {
        throw new LocalError('workspace_too_large', `git ${args[0]} produced more than ${options.maxBytes ?? MAX_PATCH_BYTES} bytes.`)
      }
      return { code: exitCode, stdout, stderr }
    } finally {
      await stdoutFd.close()
      await stderrFd.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
}

async function requireGit(cwd, args) {
  const result = await runGit(cwd, args)
  if (result.code !== 0) {
    throw new LocalError('git_failed', `git ${args.join(' ')} failed: ${result.stderr.trim() || `exit ${result.code}`}`)
  }
  return result.stdout
}

/** Read everything a push needs from the local checkout. */
export async function readLocalWorkspace(localDir) {
  const cwd = path.resolve(String(localDir ?? ''))
  const inside = (await requireGit(cwd, ['rev-parse', '--is-inside-work-tree'])).toString().trim()
  if (inside !== 'true') throw new LocalError('not_a_repo', `${cwd} is not a git work tree.`)
  let head
  try {
    head = (await requireGit(cwd, ['rev-parse', 'HEAD'])).toString().trim()
  } catch {
    throw new LocalError('no_commits', `${cwd} has no commit yet; commit once before pushing the workspace.`)
  }
  const status = await requireGit(cwd, ['status', '--porcelain', '-z', '--untracked-files=all'])
  const parsed = parsePorcelain(status)
  const patch = await requireGit(cwd, ['diff', '--binary', 'HEAD'], { maxBytes: MAX_PATCH_BYTES })
  const untracked = []
  let untrackedBytes = 0
  for (const file of parsed.untracked) {
    if (file.endsWith('/')) continue
    if (untracked.length >= MAX_UNTRACKED_FILES) {
      throw new LocalError('too_many_untracked', `More than ${MAX_UNTRACKED_FILES} untracked files; commit or ignore some first.`)
    }
    const relative = assertSafeRelative(file)
    const absolute = path.join(cwd, relative)
    const content = await readFile(absolute)
    untrackedBytes += content.length
    if (untrackedBytes > MAX_UNTRACKED_BYTES) {
      throw new LocalError('untracked_too_large', `Untracked files exceed ${MAX_UNTRACKED_BYTES} bytes.`)
    }
    untracked.push({ path: relative, content })
  }
  return {
    cwd,
    head,
    patch,
    digest: diffDigest(patch),
    changes: parsed,
    untracked,
    untrackedBytes,
    untrackedDigest: untrackedRevision(untracked),
  }
}

/** Digest over untracked names and contents, so a workspace rev covers them too. */
export function untrackedRevision(untracked = []) {
  const parts = [...untracked]
    .map((file) => ({ path: file.path, digest: sha256Bytes(file.content) }))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => `${file.path}\0${file.digest}`)
  return sha256Bytes(Buffer.from(parts.join('\n'), 'utf8'))
}

/** A bundle of every local ref, so the cloud HEAD keeps the same commit hashes. */
async function createBundle(cwd) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rayrun-bundle-'))
  const file = path.join(dir, 'head.bundle')
  try {
    await requireGit(cwd, ['bundle', 'create', file, '--all'])
    const content = await readFile(file)
    if (content.length > MAX_BUNDLE_BYTES) {
      throw new LocalError('bundle_too_large', `The git bundle is ${content.length} bytes; the limit is ${MAX_BUNDLE_BYTES}.`)
    }
    return content
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
}

async function sh(ray, machineId, command, options = {}) {
  const result = await ray.exec(
    machineId,
    { command, timeout_seconds: Math.min(Number(options.timeoutSeconds ?? 120), 3600) },
    { timeoutMs: (Number(options.timeoutSeconds ?? 120) + 30) * 1000, signal: options.signal },
  )
  return {
    stdout: String(result?.stdout ?? ''),
    stderr: String(result?.stderr ?? ''),
    code: result?.exit_code ?? null,
  }
}

/** The machine workspace root, as the guest reports it. */
export async function cloudWorkspaceRoot(ray, machineId, options = {}) {
  const out = await sh(ray, machineId, 'pwd', { ...options, timeoutSeconds: 30 })
  const root = out.stdout.trim()
  if (!SAFE_PATH.test(root)) {
    throw new LocalError('cloud_root_unusable', `The machine reported an unusable workspace root: ${JSON.stringify(root)}`)
  }
  return root
}

/**
 * What the cloud workspace holds right now, plus the bookkeeping the last push
 * left there. Section markers keep the parse independent of git's output shape.
 */
export async function readCloudState(ray, machineId, root, options = {}) {
  const out = await sh(
    ray,
    machineId,
    [
      `cd ${root}`,
      'mkdir -p .dsh/sync',
      'echo "--head--"',
      'git rev-parse HEAD 2>/dev/null || true',
      'echo "--digest--"',
      'git diff --binary HEAD > .dsh/sync/current.patch 2>/dev/null || true',
      "sha256sum .dsh/sync/current.patch 2>/dev/null | cut -d' ' -f1 || true",
      'echo "--status--"',
      'git status --porcelain 2>/dev/null | wc -l',
      'echo "--state--"',
      'cat .dsh/state.json 2>/dev/null || true',
    ].join('\n'),
    { ...options, timeoutSeconds: 120 },
  )
  const section = (name) => {
    const marker = `--${name}--\n`
    const start = out.stdout.indexOf(marker)
    if (start === -1) return ''
    const rest = out.stdout.slice(start + marker.length)
    const end = rest.search(/\n--[a-z]+--\n/)
    return (end === -1 ? rest : rest.slice(0, end)).trim()
  }
  let state = null
  const raw = section('state')
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && typeof parsed.head === 'string') state = parsed
    } catch {
      state = null
    }
  }
  return {
    head: section('head') || null,
    digest: section('digest') || EMPTY_DIGEST,
    statusLines: Number(section('status') || 0),
    state,
  }
}

/**
 * Mirror the local checkout into the cloud workspace and prove it landed:
 * same HEAD, same dirty-patch digest.
 *
 * Refuses while a cloud task holds the workspace lock, and refuses to overwrite
 * a cloud tree that moved since the last push unless `force` is set.
 */
export async function pushWorkspace(ray, machine, { localDir, force = false, lock = null, signal } = {}) {
  const root = await cloudWorkspaceRoot(ray, machine.id, { signal })
  const local = await readLocalWorkspace(localDir)
  const cloud = await readCloudState(ray, machine.id, root, { signal })
  const decision = decidePush({ local, cloud, state: cloud.state, lock, force })
  if (!decision.ok) throw new LocalError(decision.code, decision.message)
  const bundle = await createBundle(local.cwd)
  const excludes = CLOUD_OWNED.map(
    (entry) =>
      `grep -qx '${entry.replace(/[.]/g, '\\.')}' .git/info/exclude 2>/dev/null || printf '%s\\n' '${entry}' >> .git/info/exclude`,
  )
  const prepared = await sh(
    ray,
    machine.id,
    [
      `cd ${root}`,
      // Test for a repository, not for a `.git` directory: the info/exclude
      // directory below would otherwise make a fresh workspace look initialized.
      'if ! git rev-parse --git-dir >/dev/null 2>&1; then git init -q; fi',
      'mkdir -p .git/info .dsh/sync',
      ...excludes,
      'echo prepared',
    ].join('\n'),
    { signal },
  )
  if (prepared.code !== 0) {
    throw new LocalError('workspace_prepare_failed', `The cloud workspace could not be prepared: ${prepared.stderr.trim() || prepared.stdout.trim()}`)
  }
  await ray.uploadFile(machine.id, `${SYNC_DIR}/head.bundle`, bundle, signal)
  // Adopt the commit before moving the dirty changes: `git clean` would remove
  // untracked files, so they must arrive after the tree is in place.
  const target = CLOUD_OWNED.map((entry) => `-e '${entry}'`).join(' ')
  const fetched = await sh(
    ray,
    machine.id,
    [
      `cd ${root}`,
      'git fetch -q --no-tags .dsh/sync/head.bundle HEAD',
      'git checkout -q -f -B dsh FETCH_HEAD',
      `git clean -qfd ${target}`,
      'git rev-parse HEAD',
    ].join('\n'),
    { signal },
  )
  if (fetched.code !== 0) {
    throw new LocalError('workspace_fetch_failed', `The cloud workspace could not adopt the bundle: ${fetched.stderr.trim() || fetched.stdout.trim()}`)
  }
  const cloudHead = fetched.stdout.trim().split('\n').pop()
  let applied = { code: 0, stdout: 'nothing to apply', stderr: '' }
  if (local.patch.length) {
    await ray.uploadFile(machine.id, `${SYNC_DIR}/dirty.patch`, local.patch, signal)
    applied = await sh(
      ray,
      machine.id,
      [`cd ${root}`, 'git apply --binary --whitespace=nowarn .dsh/sync/dirty.patch && echo applied'].join('\n'),
      { signal },
    )
  }
  if (local.untracked.length) {
    const dirs = [...new Set(local.untracked.map((file) => path.posix.dirname(file.path)).filter((dir) => dir && dir !== '.'))]
    if (dirs.length) {
      const created = await sh(ray, machine.id, [`cd ${root}`, ...dirs.map((dir) => `mkdir -p '${dir}'`)].join('\n'), { signal })
      if (created.code !== 0) {
        throw new LocalError('workspace_dirs_failed', `The cloud workspace could not create directories: ${created.stderr.trim()}`)
      }
    }
    for (const file of local.untracked) {
      await ray.uploadFile(machine.id, file.path, file.content, signal)
    }
  }
  // Untracked files are outside the diff, so verify their bytes explicitly.
  let untrackedMatched = true
  if (local.untracked.length) {
    const sums = await sh(
      ray,
      machine.id,
      [`cd ${root}`, `sha256sum ${local.untracked.map((file) => `'${file.path}'`).join(' ')} 2>/dev/null || true`].join('\n'),
      { signal },
    )
    const remote = new Map()
    for (const line of sums.stdout.split('\n')) {
      const match = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim())
      if (match) remote.set(match[2].replace(/^\*/, ''), match[1])
    }
    for (const file of local.untracked) {
      if (remote.get(file.path) !== sha256Bytes(file.content)) {
        untrackedMatched = false
        break
      }
    }
  }
  const verified = await sh(
    ray,
    machine.id,
    [
      `cd ${root}`,
      'git rev-parse HEAD',
      'git diff --binary HEAD > .dsh/sync/cloud-dirty.patch',
      "sha256sum .dsh/sync/cloud-dirty.patch | cut -d' ' -f1",
      'git status --porcelain | wc -l',
    ].join('\n'),
    { signal },
  )
  if (verified.code !== 0) {
    throw new LocalError('workspace_verify_failed', `The cloud workspace could not be verified: ${verified.stderr.trim()}`)
  }
  const [verifiedHead = '', cloudDigest = '', statusLines = '0'] = verified.stdout.trim().split('\n')
  await ray.uploadFile(
    machine.id,
    '.dsh/state.json',
    Buffer.from(
      `${JSON.stringify(pushedState({ head: local.head, digest: local.digest, untrackedDigest: local.untrackedDigest }))}\n`,
      'utf8',
    ),
    signal,
  )
  return {
    root,
    head: local.head,
    cloudHead,
    headMatched: cloudHead === local.head && verifiedHead.trim() === local.head,
    decision: decision.reason,
    previousHead: cloud.head,
    localDigest: local.digest,
    cloudDigest: cloudDigest.trim(),
    digestMatched: cloudDigest.trim() === local.digest,
    applied: applied.code === 0,
    applyError: applied.code === 0 ? '' : (applied.stderr || applied.stdout).trim(),
    patchBytes: local.patch.length,
    patchFiles: diffFileCount(local.patch.toString('utf8')),
    untracked: local.untracked.map((file) => file.path),
    untrackedBytes: local.untrackedBytes,
    untrackedDigest: local.untrackedDigest,
    untrackedMatched,
    bundleBytes: bundle.length,
    cloudStatusLines: Number(statusLines.trim() || 0),
  }
}

/**
 * Bring the cloud workspace's changes back as files under `<localDir>/.dsh/incoming`.
 * Nothing is applied: the local tree stays the merge authority.
 */
export async function pullWorkspace(ray, machine, { localDir, signal } = {}) {
  const root = await cloudWorkspaceRoot(ray, machine.id, { signal })
  const cwd = path.resolve(String(localDir ?? ''))
  const collected = await sh(
    ray,
    machine.id,
    [
      `cd ${root}`,
      `mkdir -p ${OUTGOING_DIR}`,
      'git rev-parse HEAD',
      `git diff --binary HEAD > ${OUTGOING_DIR}/dirty.patch`,
      `git status --porcelain > ${OUTGOING_DIR}/status.txt`,
      'echo collected',
    ].join('\n'),
    { signal },
  )
  if (collected.code !== 0) {
    throw new LocalError('workspace_pull_failed', `The cloud workspace could not be read: ${collected.stderr.trim() || collected.stdout.trim()}`)
  }
  const head = collected.stdout.trim().split('\n')[0]
  const patchRes = await ray.downloadFile(machine.id, `${OUTGOING_DIR}/dirty.patch`, signal)
  const patch = Buffer.from(await patchRes.arrayBuffer())
  const statusRes = await ray.downloadFile(machine.id, `${OUTGOING_DIR}/status.txt`, signal)
  const statusText = Buffer.from(await statusRes.arrayBuffer()).toString('utf8')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(cwd, '.dsh', 'incoming', stamp)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'dirty.patch'), patch)
  await writeFile(path.join(dir, 'status.txt'), statusText)
  const changed = statusText.split('\n').filter((line) => line.trim()).length
  return {
    root,
    cloudHead: head,
    dir,
    patchPath: path.join(dir, 'dirty.patch'),
    statusPath: path.join(dir, 'status.txt'),
    patchBytes: patch.length,
    patchFiles: diffFileCount(patch.toString('utf8')),
    changed,
    digest: diffDigest(patch),
  }
}
