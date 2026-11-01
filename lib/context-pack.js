/**
 * Context Pack: the reviewable brief a cloud worker receives instead of a long
 * prompt string.
 *
 * One pack is `.dsh/handoff/<taskId>/` with:
 *  - `handoff.md`       objective, constraints, decisions, open questions, acceptance
 *  - `conversation.md`  whatever local context the caller chose to carry over
 *  - `workspace.patch`  the dirty patch that produced the pushed workspace
 *  - `manifest.json`    the version triple plus workspace/file digests
 *  - `profile.json`     which local profile and projection produced it
 *
 * The manifest is what makes delegation checkable: the worker is asked to echo
 * its revs, and the caller compares them with these values.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { scanSecrets } from './cloud-dsh.js'

export const HANDOFF_DIR = '.dsh/handoff'
export const RESULTS_DIR = '.dsh/results'
/** handoff.md must state these two before delegation is allowed. */
export const REQUIRED_BRIEF = ['objective', 'acceptance']

const MAX_PATCH_BYTES = 16 * 1024 * 1024

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** A rev that names a checkout state: HEAD, dirty tree, and untracked files. */
export function workspaceRevision({ head, dirtyDigest, untrackedDigest }) {
  return sha256(`${String(head ?? '')}\0${String(dirtyDigest ?? '')}\0${String(untrackedDigest ?? '')}`)
}

/** A rev that names a profile projection: layer plus plugin files. */
export function profileRevision({ layerRev, pluginRev }) {
  return sha256(`${String(layerRev ?? '')}\0${String(pluginRev ?? '')}`)
}

/** Which required parts of a brief are missing. */
export function validateBrief(brief = {}) {
  const missing = REQUIRED_BRIEF.filter((key) => {
    const value = brief[key]
    if (Array.isArray(value)) return value.filter((item) => String(item ?? '').trim()).length === 0
    return !String(value ?? '').trim()
  })
  return { ok: missing.length === 0, missing }
}

/** Normalize list-ish brief fields into trimmed strings. */
export function asList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item ?? '').trim()).filter(Boolean)
  const text = String(value ?? '').trim()
  return text ? [text] : []
}

function section(title, lines) {
  if (!lines.length) return `## ${title}\n\n_（未提供）_\n`
  return `## ${title}\n\n${lines.map((line) => `- ${line}`).join('\n')}\n`
}

export function renderHandoff({ taskId, round = 1, brief, revs, workspace, questions }) {
  const carried = String(questions ?? '').trim()
  const parts = [
    `# 云上任务 handoff（${taskId} · 第 ${round} 轮）`,
    '',
    '## 目标',
    '',
    String(brief.objective ?? '').trim(),
    '',
    section('约束', asList(brief.constraints)),
    section('已做决策', asList(brief.decisions)),
    section('未决问题', asList(brief.openQuestions)),
    section('验收标准', asList(brief.acceptance)),
    ...(carried
      ? [
          '## 上一轮 worker 的提问（本地已带答）',
          '',
          carried,
          '',
        ]
      : []),
    '## 版本三元组',
    '',
    `- sessionSeq: ${revs.sessionSeq ?? 'null'}`,
    `- workspaceRev: ${revs.workspaceRev}`,
    `- profileRev: ${revs.profileRev}`,
    '',
    '## 工作区',
    '',
    `- git HEAD: ${workspace?.head ?? 'unknown'}`,
    `- dirty 摘要: ${workspace?.dirtyDigest ?? 'unknown'}`,
    `- dirty 文件数: ${workspace?.dirtyFiles ?? 0}`,
    `- 未跟踪文件: ${(workspace?.untracked ?? []).length}`,
    '',
    '## 交付约定',
    '',
    `- 产物写到 \`.dsh/results/${taskId}/\`，不要修改 \`.dsh/handoff/\` 下的任何文件。`,
    `- 需要本地决定的事情，写到 \`.dsh/results/${taskId}/questions.md\` 后结束本轮，不要猜。`,
    '- 完成后用一句话总结结果与剩余风险。',
    '',
  ]
  return parts.join('\n')
}

export function renderConversation(notes) {
  const text = String(notes ?? '').trim()
  return text ? `# 本地上下文摘录\n\n${text}\n` : '# 本地上下文摘录\n\n_（本次未附带对话摘录，以 handoff.md 为准）_\n'
}

/** Assemble every pack file. Pure: the caller writes and uploads them. */
export function buildContextPack({ taskId, round = 1, brief, revs, workspace, profile, patch, notes, questions, createdAt }) {
  const validation = validateBrief(brief)
  if (!validation.ok) {
    const error = new Error(`handoff 缺少必填项：${validation.missing.join(', ')}`)
    error.code = 'brief_incomplete'
    error.missing = validation.missing
    throw error
  }
  const trimmedPatch = Buffer.isBuffer(patch) ? patch : Buffer.from(String(patch ?? ''), 'utf8')
  if (trimmedPatch.length > MAX_PATCH_BYTES) {
    const error = new Error(`workspace.patch 超过 ${MAX_PATCH_BYTES} 字节，先提交或收紧改动再委托`)
    error.code = 'patch_too_large'
    throw error
  }
  const previousQuestions = String(questions ?? '').trim()
  const files = {
    'handoff.md': renderHandoff({ taskId, round, brief, revs, workspace, questions: previousQuestions }),
    'conversation.md': renderConversation(notes),
    'workspace.patch': trimmedPatch,
    'profile.json': `${JSON.stringify(profile, null, 2)}\n`,
  }
  const manifest = {
    kind: 'dsh-rayrun-context-pack',
    version: 2,
    taskId,
    round,
    createdAt: createdAt ?? new Date().toISOString(),
    revs,
    workspace,
    profile,
    brief: {
      objective: String(brief.objective ?? '').trim(),
      constraints: asList(brief.constraints),
      decisions: asList(brief.decisions),
      openQuestions: asList(brief.openQuestions),
      acceptance: asList(brief.acceptance),
    },
    files: Object.fromEntries(
      Object.entries(files).map(([name, content]) => [name, sha256(Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'))]),
    ),
  }
  files['manifest.json'] = `${JSON.stringify(manifest, null, 2)}\n`
  // The text the caller authored must not carry a credential into the cloud.
  // `workspace.patch` is the same tree the push already mirrors, so it is
  // recorded but not treated as an authoring mistake.
  scanSecrets({
    'handoff.md': files['handoff.md'],
    'conversation.md': files['conversation.md'],
    'manifest.json': files['manifest.json'],
    'profile.json': files['profile.json'],
  })
  return { files, manifest }
}

/** Where one round's files live, relative to the checkout. */
export function roundPath(taskId, round) {
  return `${HANDOFF_DIR}/${taskId}/round-${round}`
}

/** Where the task-level bookkeeping lives, relative to the checkout. */
export function taskPath(taskId) {
  return `${HANDOFF_DIR}/${taskId}/task.json`
}

/**
 * Write one round under `<taskId>/round-<n>/` and upsert `task.json`, so a
 * follow-up round can find the task and continue it.
 */
export async function writeContextPack({ localDir, taskId, round = 1, pack }) {
  const dir = path.join(localDir, roundPath(taskId, round))
  await mkdir(dir, { recursive: true })
  for (const [name, content] of Object.entries(pack.files)) {
    await writeFile(path.join(dir, name), content)
  }
  const taskFile = path.join(localDir, taskPath(taskId))
  let task = null
  try {
    task = JSON.parse(await readFile(taskFile, 'utf8'))
  } catch {
    task = null
  }
  const now = new Date().toISOString()
  const next = {
    taskId,
    version: 1,
    createdAt: task?.createdAt ?? now,
    updatedAt: now,
    rounds: Math.max(Number(task?.rounds ?? 0), round),
    lastRound: round,
    lastObjective: pack.manifest?.brief?.objective ?? null,
  }
  await writeFile(taskFile, `${JSON.stringify(next, null, 2)}\n`)
  return { dir, task: next }
}

/** Read a task's bookkeeping, or null when this checkout has never seen it. */
export async function readTaskState({ localDir, taskId }) {
  try {
    const task = JSON.parse(await readFile(path.join(localDir, taskPath(taskId)), 'utf8'))
    return task && typeof task === 'object' && typeof task.rounds === 'number' ? task : null
  } catch {
    return null
  }
}

/** The instruction a cloud worker receives: read the round, then report. */
export function delegationPrompt({ taskId, round = 1, revs }) {
  const dir = roundPath(taskId, round)
  return [
    '[Rayrun 云上 worker 任务]',
    `1. 先读 \`${dir}/handoff.md\` 与 \`${dir}/manifest.json\`；不要修改 \`.dsh/handoff/\` 下的任何文件。`,
    `2. 在 workspace 内完成任务，产物写到 \`.dsh/results/${taskId}/\`；需要本地决定的事写到 \`.dsh/results/${taskId}/questions.md\` 后结束本轮。`,
    `3. 第一行必须先回显：REVS sessionSeq=${revs.sessionSeq ?? 'null'} workspaceRev=${revs.workspaceRev} profileRev=${revs.profileRev}`,
    '4. 结束后用一句话说明结果与剩余风险。',
  ].join('\n')
}

/** Whether a worker reply echoes the revs this delegation sent. */
export function revsEchoed(text, revs) {
  const body = String(text ?? '')
  const seq = String(revs.sessionSeq ?? 'null')
  return body.includes(`sessionSeq=${seq}`) && body.includes(`workspaceRev=${revs.workspaceRev}`) && body.includes(`profileRev=${revs.profileRev}`)
}
