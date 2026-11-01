/**
 * Delegation: hand one task to the DSH worker running inside a Rayrun machine.
 *
 * The local session stays authoritative. A delegation therefore does four
 * checkable things before the worker is asked anything, and one after:
 *
 *  1. mirror the workspace and prove HEAD + dirty digest (`pushWorkspace`);
 *  2. prove the cloud profile is the local projection (sync it if it drifted);
 *  3. write a Context Pack locally and upload it to `.dsh/handoff/<taskId>/`;
 *  4. take the workspace lock, post the prompt, stream the run;
 *  5. collect whatever the worker wrote into `.dsh/results/<taskId>/`.
 *
 * The worker is told to echo the version triple; `echoed` records whether it
 * did, so a caller can tell "the worker read the pack" from "it guessed".
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readCloudWorker, syncCloudWorker } from './cloud-dsh.js'
import { readLocalWorkspace, pushWorkspace } from './cloud-workspace.js'
import {
  RESULTS_DIR,
  buildContextPack,
  delegationPrompt,
  profileRevision,
  readTaskState,
  revsEchoed,
  roundPath,
  validateBrief,
  workspaceRevision,
  writeContextPack,
} from './context-pack.js'
import { LocalError } from './rayrun.js'
import { isFinished, kindOf, readFrame, sseFrames } from './sse.js'

const MAX_RESULT_FILES = 50
const MAX_RESULT_BYTES = 4 * 1024 * 1024

/**
 * Delegate `brief` to the machine's worker.
 *
 * `deps.project` returns the local projection (so this module needs no profile
 * context); `deps.sessionSeq` is the local session's sequence number or null;
 * `deps.locks` is the WorkspaceLocks instance shared with the other tools.
 */
export async function delegateTask({
  ray,
  machine,
  localDir,
  brief,
  notes,
  taskId: continueTaskId,
  timeoutMs = 900_000,
  signal,
  locks,
  project,
  sessionSeq = null,
} = {}) {
  const check = validateBrief(brief)
  if (!check.ok) {
    throw new LocalError('brief_incomplete', `handoff 缺少必填项：${check.missing.join(', ')}（objective / acceptance）`)
  }
  // Continuing a task keeps its id and carries the worker's open questions into
  // the next round; a fresh task starts at round 1.
  let taskId
  let round = 1
  let questions = ''
  if (continueTaskId) {
    taskId = String(continueTaskId)
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(taskId)) throw new LocalError('invalid_task_id', `Unusable task id: ${JSON.stringify(taskId)}`)
    const state = await readTaskState({ localDir, taskId })
    round = Math.max(1, Number(state?.rounds ?? 0)) + 1
    try {
      questions = await readFile(path.join(localDir, RESULTS_DIR, taskId, 'questions.md'), 'utf8')
    } catch {
      questions = ''
    }
  } else {
    taskId = `task-${Date.now().toString(36)}`
  }
  const before = await ray.machine(machine.id).catch(() => null)
  const pushed = await pushWorkspace(ray, machine, { localDir, lock: locks?.status(machine.id) ?? null, signal })
  if (!pushed.headMatched || !pushed.digestMatched || !pushed.applied) {
    throw new LocalError('workspace_not_mirrored', 'The cloud workspace did not mirror the local checkout; run rayrun_workspace push and resolve it first.')
  }
  const projection = await project()
  const remote = await readCloudWorker(ray, machine, projection, { signal })
  let resynced = false
  if (remote.remoteRev !== projection.rev || remote.plugin?.remoteRev !== projection.pluginRev) {
    const sync = await syncCloudWorker(ray, machine, projection, { signal })
    if (!sync.synced || (sync.plugin && !sync.plugin.synced)) {
      throw new LocalError('projection_not_applied', 'The cloud worker profile could not be synced before delegation.')
    }
    resynced = true
  }
  const revs = {
    sessionSeq: Number.isSafeInteger(sessionSeq) ? sessionSeq : null,
    workspaceRev: workspaceRevision({
      head: pushed.head,
      dirtyDigest: pushed.localDigest,
      untrackedDigest: pushed.untrackedDigest,
    }),
    profileRev: profileRevision({ layerRev: projection.rev, pluginRev: projection.pluginRev }),
  }
  const local = await readLocalWorkspace(localDir)
  const pack = buildContextPack({
    taskId,
    round,
    brief,
    revs,
    workspace: {
      head: pushed.head,
      dirtyDigest: pushed.localDigest,
      dirtyFiles: pushed.patchFiles,
      untracked: pushed.untracked,
      untrackedDigest: pushed.untrackedDigest,
    },
    profile: {
      name: projection.manifest.sourceProfile,
      sourceRev: projection.manifest.sourceRev,
      layerRev: projection.rev,
      pluginRev: projection.pluginRev,
      pluginVersion: projection.manifest.plugin?.version ?? null,
    },
    patch: local.patch,
    notes,
    questions,
  })
  const written = await writeContextPack({ localDir, taskId, round, pack })
  for (const [name, content] of Object.entries(pack.files)) {
    await ray.uploadFile(
      machine.id,
      `${roundPath(taskId, round)}/${name}`,
      Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
      signal,
    )
  }
  const root = pushed.root
  await ray.exec(
    machine.id,
    { command: `cd ${root} && mkdir -p ${RESULTS_DIR}/${taskId}`, timeout_seconds: 30 },
    { timeoutMs: 60_000, signal },
  )
  const holder = `delegate ${taskId}`
  locks?.acquire(machine.id, { holder, reason: taskId, ttlMs: timeoutMs + 120_000 })
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('delegate timeout')), timeoutMs)
  const messages = []
  let final = ''
  let outcome = ''
  let cost = 0
  let finished = false
  let promptId = null
  try {
    const streamed = ray.openEvents(machine.id, controller.signal)
    const posted = await ray.postPrompt(machine.id, delegationPrompt({ taskId, round, revs }), controller.signal)
    promptId = posted?.prompt_id ?? null
    const res = await streamed
    for await (const event of sseFrames(res, controller.signal)) {
      const kind = kindOf(event)
      if (!kind) continue
      if (kind === 'agent.raw' || kind === 'agent.message') {
        const frame = readFrame(event, kind)
        if (frame.final) final = frame.final
        else if (frame.message) messages.push(frame.message)
        else if (frame.narration) messages.push(frame.narration)
        continue
      }
      if (kind === 'agent.usage' && typeof event.payload?.cost_usd === 'number') {
        cost += event.payload.cost_usd
        continue
      }
      if (kind.startsWith('agent.') && isFinished(kind)) {
        finished = true
        const { class: klass, code } = event.payload ?? {}
        outcome = [klass, code != null ? `code ${code}` : ''].filter(Boolean).join(' ')
        break
      }
    }
    const echoed = revsEchoed([messages.slice(0, 3).join('\n'), final].join('\n'), revs)
    const after = await ray.machine(machine.id).catch(() => null)
    const vmHours = Number(after?.usage?.vm_hours ?? 0) - Number(before?.usage?.vm_hours ?? 0)
    const results = []
    const listing = await ray.exec(
      machine.id,
      { command: `cd ${root} && ls -1 ${RESULTS_DIR}/${taskId} 2>/dev/null | head -${MAX_RESULT_FILES}`, timeout_seconds: 30 },
      { timeoutMs: 60_000, signal: controller.signal },
    )
    const names = String(listing?.stdout ?? '')
      .split('\n')
      .map((name) => name.trim())
      .filter((name) => name && !name.includes('/') && name !== '.' && name !== '..')
    for (const name of names) {
      const download = await ray.downloadFile(machine.id, `${RESULTS_DIR}/${taskId}/${name}`, controller.signal)
      const bytes = Buffer.from(await download.arrayBuffer())
      if (bytes.length > MAX_RESULT_BYTES) continue
      const dir = path.join(localDir, RESULTS_DIR, taskId)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, name), bytes)
      results.push(name)
    }
    return {
      machine: machine.name ?? machine.id,
      taskId,
      round,
      promptId,
      revs,
      echoed,
      finished,
      outcome,
      cost,
      vmHours: Number.isFinite(vmHours) ? vmHours : 0,
      resynced,
      packDir: written.dir,
      taskFile: path.join(path.dirname(written.dir), 'task.json'),
      resultsDir: path.join(localDir, RESULTS_DIR, taskId),
      results,
      text: (final || messages.join('\n')).trim(),
    }
  } finally {
    locks?.release(machine.id, holder)
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    controller.abort()
  }
}
